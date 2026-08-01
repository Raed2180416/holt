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
import { ensureOnPath } from './toolchain.mjs';

/* ------------------------------------------------------------------ ctags ---- */

let _ctagsProbe = null;

/**
 * Forget every cached toolchain probe.
 *
 * `holt setup` probes for ctags, finds none, INSTALLS one, and then scans — all in one process.
 * Without this the scan would use the memoised "unavailable" verdict from before the install and
 * silently fall back to regex extraction, so the command that just fixed the toolchain would
 * report the machine as if it had not.
 */
export function resetToolchainProbes() {
  _ctagsProbe = null;
  _enryProbe = null;
  _langProbe = null;
  _demoProbe = null;
  _compat = null;
  _extraFlags = [];
}

/** Detect universal-ctags once per process. Exuberant ctags is NOT accepted — no JSON. */
export async function detectCtags() {
  if (_ctagsProbe) return _ctagsProbe;
  // A portable ctags installed by `holt setup` lives in holt's own directory, not on the system
  // PATH. Putting it on PATH here means every call site finds it without knowing it exists.
  await ensureOnPath();
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

/**
 * Minimal real source per language that distro ctags builds have historically shipped without.
 *
 * WHY THESE EXIST. `ctags --list-languages` is a DECLARATION, and holt trusted it. holt's optlib
 * gap pack loads without error on an older ctags, so that ctags then *lists* Terraform and Elm
 * while extracting nothing from either — and holt reported coverage it could not deliver. CI
 * caught it as two silent languages; a user would have caught it as a worktree whose unique
 * symbols were invisible, which is the failure mode holt exists to prevent.
 *
 * So capability is now DEMONSTRATED: parse a real fragment and require a symbol back. Presence,
 * not a claim about presence.
 */
const PROBE_SOURCES = {
  // [file, source, THE SYMBOL THAT MUST COME BACK BY NAME]
  //
  // The third element is not decoration. An earlier version of this probe accepted ANY symbol,
  // and the Elm sample carried a `module … exposing` header: ctags 5.9.0 extracted the MODULE,
  // returned one symbol, and the probe declared Elm supported — while the thing holt actually
  // needs from Elm, a top-level function, extracted nothing. The probe was easier than the
  // question it was asked. Each sample is now the plainest form of the construct holt depends
  // on, and the named symbol must come back or the language does not count.
  Groovy: ['holt-probe.groovy', 'class HoltProbeCls {\n  def holtProbe() { }\n}\n', 'holtProbe'],
  FSharp: ['holt-probe.fsx', 'module HoltProbeMod\nlet holtProbe x = x\n', 'holtProbe'],
  Prolog: ['holt-probe.pro', 'holtProbe(X) :- X > 1.\n', 'holtProbe'],
  Dockerfile: ['Dockerfile', 'FROM alpine AS holtProbe\nARG HOLT_PROBE_ARG=1\n', 'holtProbe'],
  GraphQL: ['holt-probe.graphql', 'type holtProbe {\n  id: ID!\n}\n', 'holtProbe'],
  Terraform: ['holt-probe.tf', 'resource "aws_s3_bucket" "holtProbe" {}\n', 'holtProbe'],
  Elm: ['holt-probe.elm', 'holtProbe : Int -> Int\nholtProbe x = x\n', 'holtProbe'],
  Julia: ['holt-probe.jl', 'function holtProbe(x)\n    x + 1\nend\n', 'holtProbe'],
  Zig: ['holt-probe.zig', 'pub fn holtProbe() void {}\n', 'holtProbe'],
  Nim: ['holt-probe.nim', 'proc holtProbe(): int =\n  1\n', 'holtProbe'],
  Crystal: ['holt-probe.cr', 'def holtProbe\n  1\nend\n', 'holtProbe'],
  Solidity: ['holt-probe.sol', 'contract HoltProbe {\n  function holtProbe() public {}\n}\n', 'holtProbe'],
  Dart: ['holt-probe.dart', 'void holtProbe() {}\n', 'holtProbe'],
  Swift: ['holt-probe.swift', 'func holtProbe() {}\n', 'holtProbe'],
  Scala: ['holt-probe.scala', 'object HoltProbeObj {\n  def holtProbe = 1\n}\n', 'holtProbe'],
};

let _demoProbe = null;
let _compat = null;
let _inProbe = false;   // guards the probe's own extraction from re-entering ensureCompat()

/** Run the probe corpus through the CURRENT flags; return the languages that truly extract. */
async function runProbe() {
  const backend = await resolveBackend();
  if (backend.kind !== 'ctags') return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-langprobe-'));
  _inProbe = true;
  try {
    const files = [];
    const byFile = new Map();
    for (const [lang, [file, src]] of Object.entries(PROBE_SOURCES)) {
      await fs.writeFile(path.join(dir, file), src, 'utf8');
      files.push(file);
      byFile.set(file, lang);
    }
    const found = await symbolsOnDisk(dir, files, backend);
    const ok = new Set();
    for (const [file, lang] of byFile) {
      const want = PROBE_SOURCES[lang][2];
      const names = (found.get(file) ?? []).map((x) => x.name ?? String(x.key ?? '').split(':').pop());
      if (names.includes(want)) ok.add(lang);
    }
    return ok;
  } catch {
    return null; // the probe itself broke — callers fall back to the declaration, never to silence
  } finally {
    _inProbe = false;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Measure this toolchain, then close the gaps it actually has.
 *
 * NEVER CONCEDE A LANGUAGE TO THE TOOLCHAIN. The earlier behaviour here was to detect that a
 * ctags could not parse Terraform or Elm and simply report reduced coverage — which on Ubuntu
 * 24.04 LTS (universal-ctags 5.9.0) means every .tf and .elm file in the repository silently
 * yields no symbols. Silence reads as "these two agents share nothing", so the coverage gap
 * becomes a wrong ANSWER, not just a smaller number.
 *
 * So: probe, load a compat definition for each language that failed, then probe AGAIN and keep
 * only what the second probe proves. A compat pack that does not actually work is reported as a
 * remaining gap rather than assumed to have helped.
 *
 * Measured on universal-ctags 5.9.0: Terraform and Elm go from 0 symbols to full extraction.
 * On 6.2.1 nothing is missing, no compat file is loaded, and this costs one probe.
 */
async function ensureCompat() {
  if (_compat) return _compat;
  _compat = (async () => {
    const before = await runProbe();
    if (!before) return { loaded: [], fixed: [], stillMissing: [], supported: null };

    const missing = Object.keys(PROBE_SOURCES).filter((l) => !before.has(l));
    if (!missing.length) return { loaded: [], fixed: [], stillMissing: [], supported: before };

    const loaded = [];
    for (const lang of missing) {
      const file = path.join(COMPAT_DIR, `${lang}.ctags`);
      try { await fs.access(file); loaded.push(`--options=${file}`); } catch { /* no pack for it */ }
    }
    if (!loaded.length) return { loaded: [], fixed: [], stillMissing: missing, supported: before };

    _extraFlags = loaded;
    const after = await runProbe();
    if (!after) { _extraFlags = []; return { loaded: [], fixed: [], stillMissing: missing, supported: before }; }

    // A compat pack must never cost a language that already worked.
    const regressed = [...before].filter((l) => !after.has(l));
    if (regressed.length) {
      _extraFlags = [];
      return { loaded: [], fixed: [], stillMissing: missing, regressed, supported: before };
    }
    return {
      loaded,
      fixed: missing.filter((l) => after.has(l)),
      stillMissing: missing.filter((l) => !after.has(l)),
      supported: after,
    };
  })();
  return _compat;
}

/** Which languages this toolchain can extract, AFTER holt has closed what it can. */
async function demonstratedLanguages() {
  if (_demoProbe) return _demoProbe;
  _demoProbe = ensureCompat().then((c) => c.supported);
  return _demoProbe;
}

/** Diagnostic for `holt doctor`: what was missing, what holt fixed, what is genuinely left. */
export async function compatReport() {
  return ensureCompat();
}

export async function languageCoverage(expected = []) {
  const probe = await ctagsLanguages();
  if (!probe.available) {
    return { available: false, total: probe.count, missing: [], note: 'ctags unavailable — the regex fallback applies to every language' };
  }
  // A language counts as supported only if this toolchain DEMONSTRABLY extracts a symbol from it.
  // Falling back to the declaration when the demonstration itself fails keeps a broken probe from
  // silently reporting zero coverage, which would read as "upgrade ctags" to someone whose ctags
  // is fine.
  const demonstrated = await demonstratedLanguages();
  const missing = expected.filter((l) => (demonstrated && PROBE_SOURCES[l]
    ? !demonstrated.has(l)
    : !probe.languages.has(l)));
  return {
    available: true,
    total: probe.count,
    checked: expected.length,
    supported: expected.length - missing.length,
    missing,
    note: missing.length
      ? `this ctags lists but cannot actually parse ${missing.join(', ')} — upgrade universal-ctags (distro packages lag; 6.x adds these)`
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
/**
 * Declarations that NAME A CONTAINER rather than author anything in it.
 *
 * MEASURED: on a 1,000-pair labelled corpus, EVERY false positive holt produced was Go, and every
 * one traced to a single tag — ctags emits `package corpus` with kind "package" for the package
 * clause that each file in a Go package repeats verbatim. It normalised to a plain symbol, so any
 * NEW file in an existing package looked like it had added work found nowhere else, and two
 * agents adding unrelated files to the same package looked like they had built the same thing.
 *
 * The class is not Go's: Java, Kotlin and Scala repeat `package`, C# repeats `namespace`. None of
 * them is work — they are the address the work lives at, and every file at that address restates
 * it, so counting them turns file COUNT into apparent symbol overlap.
 *
 * DELIBERATELY NARROW, and `module` is the line. Go's `package corpus` is repeated verbatim by
 * every file in the package; F#'s `module FsModule`, Elixir's `defmodule` and Haskell's module
 * header name ONE thing ONCE and a developer owns that name. Excluding `module` would have made
 * holt blind to real work in those languages — the language suite asserts exactly those symbols,
 * which is how the over-broad first version of this filter was caught.
 */
const CONTAINER_KINDS = new Set(['package', 'namespace']);

/**
 * DATA LEAVES. A scalar sitting inside a document is a value, not an authored symbol.
 *
 * These are the kinds ctags emits for JSON/YAML/TOML content — `{"c": 1}` yields kind "number",
 * `{"n": "x"}` yields "string". No programming language names a function "number" or a class
 * "boolean", so filtering on the TAG'S OWN KIND cannot swallow real code, which is the property
 * the rule it replaces did not have.
 *
 * Deliberately excludes `object` and `array`: Scala's `object` is a first-class code construct
 * with the same kind name, and the repeated-metadata-key problem those would have caught
 * (`generatedAt`, `head`, `$comment` appearing in every receipt file in a repo) is already solved
 * measurably by the inverse-document-frequency filter in analyze.mjs — a blocklist was tried
 * there and rejected in favour of IDF for exactly this reason.
 */
const DATA_LEAF_KINDS = new Set(['number', 'string', 'boolean', 'null']);

function isNoise(tag) {
  if (!tag || typeof tag.name !== 'string') return true;
  if (CONTAINER_KINDS.has(String(tag.kind))) return true;
  if (tag.name.startsWith('anonymousObject')) return true;
  // A DOTTED SCOPE USED TO MEAN "NOISE", AND IT MEANT "NAMESPACED".
  //
  // The rule was `tag.scope.includes('.') -> drop`, intended for values nested inside a document.
  // A dotted scope is also exactly how ctags renders an ordinary namespace or package: C#'s
  // `namespace Newtonsoft.Json`, Kotlin's `package kotlin.collections`, Clojure's
  // `(ns clojure.string)`. So every symbol in virtually all real C#, Kotlin and Clojure was
  // discarded — measured on real upstream files from Newtonsoft.Json, JetBrains/kotlin and
  // clojure/clojure: bare ctags found 79, 105 and 22 tags; holt returned ZERO from each.
  //
  // It survived because holt's own language fixtures are bare one-liners that declare no
  // namespace, which is what a manufactured test looks like and what real code never does.
  if (DATA_LEAF_KINDS.has(String(tag.kind))) return true;
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
const COMPAT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'optlib', 'compat');

/**
 * Compat packs for gaps THIS toolchain has — decided by measurement, never by version number.
 *
 * A version check would be a guess: distros patch, users build their own, and a language can be
 * present-but-broken (ctags 5.9.0 lists Elm and extracts no functions from it). So holt runs its
 * probe, sees which languages actually fail, and loads a definition for exactly those. On a
 * toolchain with no gaps this array stays empty and nothing changes.
 *
 * Set by ensureCompat(); read by optionFlags(). Never loaded on a ctags that already has the
 * parser, because --langdef would collide with it.
 */
let _extraFlags = [];

function optionFlags() {
  const flags = [`--options=${OPTLIB}`, ..._extraFlags];
  const user = process.env.HOLT_CTAGS_OPTIONS;
  if (user) flags.push(`--options=${user}`); // loaded last, so user definitions win
  return flags;
}

/**
 * Run ctags over a set of files in one invocation.
 * @returns {Promise<Map<string, Array<{name,kind,line,scope}>>>} keyed by the given rel path
 */
export async function ctagsBatch(cwd, relPaths, { timeout = 60_000, chunk = 400, languageForce = null } = {}) {
  const result = new Map();
  if (relPaths.length === 0) { result.failed = []; return result; }

  if (!_inProbe) await ensureCompat(); // close this toolchain's gaps before extracting anything
  // Files whose extraction ERRORED. Carried on the result so every caller can distinguish
  // "no symbols here" from "could not look", which are the same value and opposite meanings.
  const failed = new Set();
  const usable = await tagWorthy(cwd, relPaths);
  for (const p of relPaths) result.set(p, []); // unusable paths are "no symbols", never "unscanned"
  if (usable.length === 0) { result.failed = []; return result; }

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
        // A FAILURE MUST NOT LOOK LIKE AN EMPTY ANSWER. Measured: a file containing a real symbol
        // returns [] under a 1ms timeout — byte-identical to a file that genuinely has none. That
        // silence then reads as "these two workstreams share nothing", so a timed-out extraction
        // under CI load became a confident "no duplicates" and a worktree that looked disposable.
        // The error is carried out of here so callers can say UNMEASURED instead of "nothing".
        (err, out) => resolve({ text: err && !out ? '' : String(out ?? ''), err: err ?? null }),
      );
    });
    if (stdout.err) for (const f of group) failed.add(f);

    for (const line of stdout.text.split('\n')) {
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

  result.failed = [...failed];
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

/**
 * Translate a language name to the one THIS process can actually force.
 *
 * Ambiguous extensions (.fs is F# or Forth, .pl is Perl or Prolog) are classified by content and
 * then passed to ctags as `--language-force=<name>`. When holt supplies the parser itself, that
 * parser is defined under a private name — `HoltFSharp`, not `FSharp` — precisely so it can never
 * collide with a builtin. Forcing the public name would then name a parser that does not exist
 * here, ctags would extract nothing, and the file would be reported as having no symbols: the
 * silence that reads as "these agents share nothing".
 */
function forcedName(lang) {
  if (!lang) return lang;
  const priv = `Holt${lang}`;
  return _extraFlags.some((f) => f.endsWith(`${lang}.ctags`)) ? priv : lang;
}

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
  // Aggregated from every ctagsBatch below. An extraction that ERRORED is not an empty answer,
  // and callers must be able to tell the difference — see the note in ctagsBatch.
  const failed = new Set();
  if (relPaths.length === 0) return result;
  // Resolve the toolchain's gaps BEFORE anything reads _extraFlags. forcedName() below decides
  // whether an ambiguous file is forced to `FSharp` or to holt's private `HoltFSharp`, and that
  // answer depends on which compat packs are loaded — so computing it first would ask the
  // question before the answer existed, force a parser that is not there, and get silence.
  if (backend.kind === 'ctags' && !_inProbe) await ensureCompat();

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
      const m = await ctagsBatch(dir, files, { languageForce: forcedName(lang) });
      for (const f of m.failed ?? []) failed.add(f);
      for (const [f, syms] of m) result.set(f, syms);
    }
  } else {
    ctagsFiles.push(...ambiguous);
  }

  if (backend.kind === 'ctags' && ctagsFiles.length) {
    const m = await ctagsBatch(dir, ctagsFiles);
    for (const f of m.failed ?? []) failed.add(f);
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
  result.failed = [...failed];
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
