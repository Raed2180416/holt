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
import { pmap, catFileBatch } from './git.mjs';
import { ensureOnPath } from './toolchain.mjs';
import { readStableRegularFile } from './stable-file.mjs';

/* ------------------------------------------------------------------ ctags ---- */

// The probe caches are annotated because `let _x = null` infers the type `null`, which makes
// every detect*() return type `null`-shaped and every caller's field access "possibly 'null'" —
// 14 diagnostics in bin/holt.mjs alone traced back to these declarations.
/** @type {Promise<{available: boolean, version?: string, reason?: string}>|null} */
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
/** @type {Promise<any>|null} */
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

/** @type {Promise<any>|null} */
let _demoProbe = null;
/** @type {Promise<any>|null} */
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
  _demoProbe = ensureCompat().then((c) => c?.supported);
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
  // A real, non-empty file over MAX_TAG_FILE_BYTES is a POLICY SKIP, not a demonstrated absence of
  // symbols — holt chose not to look, the same distinction ctagsBatch already draws for a timed-out
  // extraction (see its own doc comment). Carried back separately from `keep` so the caller can
  // mark these `failed` instead of folding them into the same `[]` a genuinely empty/unknown file
  // produces; a zero here must never be silently indistinguishable from "nothing to find".
  const oversized = [];
  await pmap(relPaths, async (rel) => {
    try {
      // lstat, NOT stat. stat() follows the link and answers about its TARGET, so a symlink to a
      // .js file passes isFile() and ctags then extracts the TARGET's symbols and attributes them
      // to this worktree — symbols git does not track here at all (what git tracks at a symlink
      // path is the target string). A symlink genuinely declares nothing, so it correctly falls
      // into the "no symbols" branch rather than into `failed`: holt did look, and there is
      // nothing at this path to find. Same class as content-identity.mjs `pathContentKey`.
      const st = await fs.lstat(path.join(cwd, rel));
      if (!st.isFile() || st.size === 0) return; // not a file, or genuinely empty: correctly "no symbols"
      if (st.size > MAX_TAG_FILE_BYTES) { oversized.push(rel); return; }
      keep.push(rel);
    } catch {
      /* vanished between scan and tag — not an error, just nothing to tag */
    }
  }, 16);
  return { keep, oversized };
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
// Resolve assets through the package root, not through this module's output directory. The
// published GitHub Action is one generated ESM bundle under dist/, while a normal npm install
// executes this source file under src/. In both layouts ../package.json identifies the package
// root, so the exact same reviewed optlib bytes are used instead of silently looking for a
// nonexistent dist/optlib directory and degrading symbol evidence only in CI.
const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const OPTLIB = path.join(PACKAGE_ROOT, 'src', 'optlib', 'holt.ctags');
const COMPAT_DIR = path.join(PACKAGE_ROOT, 'src', 'optlib', 'compat');

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
 * @returns {Promise<Map<string, Array<{name,kind,line,scope}>> & {failed: string[]}>} keyed by the given rel path
 */
export async function ctagsBatch(cwd, relPaths, { timeout = 60_000, chunk = 400, languageForce = null } = {}) {
  /** @type {any} */
  const result = new Map();
  if (relPaths.length === 0) { result.failed = []; return result; }

  if (!_inProbe) await ensureCompat(); // close this toolchain's gaps before extracting anything
  // Files whose extraction ERRORED. Carried on the result so every caller can distinguish
  // "no symbols here" from "could not look", which are the same value and opposite meanings.
  const failed = new Set();
  const { keep: usable, oversized } = await tagWorthy(cwd, relPaths);
  for (const p of relPaths) result.set(p, []); // unusable paths are "no symbols", never "unscanned"
  // A file too large to tag is holt CHOOSING not to look, not a proof the file has no symbols —
  // it must be named the same way a timed-out extraction is, below, or it is silently
  // indistinguishable from a genuinely empty file.
  for (const p of oversized) failed.add(p);
  if (usable.length === 0) { result.failed = [...failed]; return result; }

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
          ...group.map(argSafePath),
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
      // ctags echoes back the path exactly as it was given, so the `./` that argSafePath adds to
      // stop a filename being read as an option comes back too. Every caller keys on the ORIGINAL
      // relative path, so it is stripped here — at the one boundary where ctags' output becomes
      // holt's data — rather than at each of the call sites that would have to remember.
      const file = tag.path.startsWith('./') ? tag.path.slice(2) : tag.path;
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

/** @type {Promise<{available: boolean, version?: string, reason?: string}>|null} */
let _enryProbe = null;

/** Normalise upstream's source-built version placeholders into an honest diagnostic. */
export function normalizeEnryVersionOutput(output) {
  const raw = String(output ?? '').trim().split('\n')[0] ?? '';
  return /^(?:not-set|undefined)?$/iu.test(raw) ? '(unversioned build)' : raw;
}

/** Detect enry (the Go port of GitHub Linguist) once per process. */
export async function detectEnry() {
  if (_enryProbe) return _enryProbe;
  await ensureOnPath();
  _enryProbe = new Promise((resolve) => {
    execFile('enry', ['-version'], { timeout: 5000 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`;
      // enry -version prints the version and exits 0; some builds exit non-zero on -version
      // but still print, so presence of output is the real signal.
      if (err && !out.trim()) return resolve({ available: false, reason: 'enry-not-found' });
      // Release builds print a version; source-built variants print "not-set" or "undefined".
      // Either way the binary works — do not surface a build artefact as if it were a version.
      const version = normalizeEnryVersionOutput(out);
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

function classifyWithEnry(cwd, rel) {
  return new Promise((resolve) => {
    execFile('enry', ['-json', rel], { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        try { resolve(JSON.parse(String(stdout))); }
        catch { resolve(null); }
      });
  });
}

/**
 * A NUL-stripped copy of one file, at the SAME relative path under `root`.
 *
 * Preserving the relative path (not just the basename) matters: enry's vendored/path heuristics
 * look at the surrounding path (`vendor/`, `node_modules/`, …), and two different directories can
 * share a basename. Returns null if the file could not be read or held no NUL byte to begin with
 * (callers only reach here after a `Binary` verdict, so the latter should not happen in practice).
 */
async function sanitizedCopyForClassification(cwd, rel, root) {
  try {
    const buf = await fs.readFile(path.join(cwd, rel));
    if (!buf.includes(0)) return null;
    const cleaned = Buffer.from(buf);
    for (let i = 0; i < cleaned.length; i++) if (cleaned[i] === 0) cleaned[i] = 0x20; // NUL -> space
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, cleaned);
    return dest;
  } catch {
    return null;
  }
}

export async function resolveAmbiguous(cwd, relPaths) {
  const out = new Map();
  if (relPaths.length === 0) return out;

  const probe = await detectEnry();
  if (!probe.available) return out; // caller falls back to extension mapping and reports it

  // ENRY'S "Binary" TYPE IS A CONTENT SNIFF (does the file contain a NUL byte near the start),
  // NOT A VERDICT THAT THE FILE HOLDS NO SOURCE.
  //
  // MEASURED (bench50, r11-a-cs/wt-nul): a real, compiling C# file whose only unusual content is
  // a literal NUL byte inside a trailing `//` comment comes back from enry as
  // `{"language":"","type":"Binary"}` — indistinguishable, to a reader of `language` alone, from
  // an actual compiled binary. ctags, run on the IDENTICAL bytes, extracts both declarations
  // cleanly (verified directly: `class` + `method` tags, both present). Treating that Binary
  // verdict as authoritative silently zeroed uniqueWork()'s symbol count for the file, across
  // every ambiguous-extension language in the corpus that plants a NUL byte — reported by the
  // tool that exists to say "this is unique" as "nothing here is unique".
  //
  // The fix reclassifies on a NUL-stripped COPY, used for classification only — ctags always
  // reads the real on-disk bytes (symbolsOnDisk/ctagsBatch never touch this temp copy). A naive
  // fallback to plain extension-based ctags (no language-force) is NOT enough here: two of holt's
  // "gap" languages (FSharp, Prolog) live at ambiguous extensions ctags maps by DEFAULT to a
  // different language entirely (measured: bare ctags maps `.fs` to Forth and extracts nothing
  // from real F#), so skipping enry's classification would silently reintroduce the same
  // zero-symbols failure for exactly those two languages. Reclassifying keeps the real language
  // name flowing into `forcedName()` the same way a non-NUL file already does.
  /** @type {string|null} */
  let sanitizedRoot = null;
  const ensureSanitizedRoot = async () => {
    if (!sanitizedRoot) sanitizedRoot = await fs.mkdtemp(path.join(scratchDir(), 'holt-enry-nul-'));
    return sanitizedRoot;
  };

  try {
    await pmap(relPaths, async (rel) => {
      let parsed = await classifyWithEnry(cwd, rel);

      if (parsed && parsed.type === 'Binary') {
        const root = await ensureSanitizedRoot();
        const sanitizedAbs = await sanitizedCopyForClassification(cwd, rel, root);
        if (sanitizedAbs) parsed = (await classifyWithEnry(root, rel)) ?? parsed;
      }

      if (!parsed) { out.set(rel, null); return; }

      // Still no verdict after stripping NUL bytes (a genuinely binary file, or enry could not
      // read even the sanitized copy): treat exactly like enry being unavailable — leave `rel`
      // UNSET, which sends it through `symbolsOnDisk`'s `lang === undefined` path into plain
      // extension-based ctags detection, rather than the `lang === null` "not-code" path. A truly
      // binary file still yields no tags from ctags; it only gets the chance to be read.
      if (parsed.type === 'Binary') return;

      if (!parsed.language) { out.set(rel, null); return; }
      const mapped = LINGUIST_TO_CTAGS.has(parsed.language) ? LINGUIST_TO_CTAGS.get(parsed.language) : parsed.language;
      out.set(rel, mapped);
    }, 12);
  } finally {
    if (sanitizedRoot) await fs.rm(sanitizedRoot, { recursive: true, force: true }).catch(() => {});
  }

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
  // JavaScript / TypeScript — the original patterns, kept verbatim
  [/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, 'binding'],
  [/^\s*(?:export\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/, 'type'],
  // Python
  [/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/, 'function'],
  [/^\s*class\s+([A-Za-z_][\w]*)/, 'class'],
  // Go
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, 'function'],
  [/^\s*(?:type\s+)?struct\s*\{/, 'type'], // anonymous struct — no name, but marks the file as having structure
  [/^\s*type\s+([A-Za-z_][\w]*)\s/, 'type'],
  // Rust
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, 'function'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/, 'type'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:type|mod|use)\s+([A-Za-z_][\w]*)/, 'type'],
  // Java / Kotlin / Scala
  [/^\s*(?:public|private|protected|internal)?\s*(?:abstract\s+)?(?:class|interface|enum|object)\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+)?(?:void|int|boolean|String|[A-Z][\w]*)\s+([A-Za-z_$][\w$]*)\s*\(/, 'function'],
  // Ruby
  [/^\s*(?:def\s+)(?:self\.)?([A-Za-z_][\w]*)/, 'function'],
  [/^\s*(?:module|class)\s+([A-Z][\w]*)/, 'class'],
  // C / C++
  [/^\s*(?:static\s+)?(?:inline\s+)?(?:void|int|char|double|float|size_t|bool|auto)\s+\*?([A-Za-z_][\w]*)\s*\(/, 'function'],
  [/^\s*(?:typedef\s+)?struct\s+([A-Za-z_][\w]*)/, 'type'],
  [/^\s*#define\s+([A-Z_][A-Z0-9_]*)/, 'macro'],
  // Shell / Bash
  [/^\s*([A-Za-z_][\w]*)\s*\(\s*\)\s*\{/, 'function'],
  // Config / constants — the original pattern, kept verbatim
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

/**
 * MINIFIED FILE DETECTION — wrong symbol counts from the regex fallback.
 *
 * WHY THIS EXISTS. The regex fallback (fallbackExtract) is line-oriented: it matches a
 * declaration at the START of a line. A minified file is one or two enormous lines with every
 * statement separated by `;` or `,`, so the regex sees a single 50,000-character "line",
 * matches the FIRST declaration on it, and reports ONE symbol for a file that contains hundreds.
 * That is not reduced coverage — it is a confidently wrong number, and a worktree whose only
 * delta is a minified bundle then looks like it contributed almost nothing.
 *
 * THE HEURISTIC, and why it is tokens-per-line rather than a name list. A list of "known
 * minified filename patterns" (*.min.js, bundle.js, vendor.js) is exactly the kind of
 * blocklist analyze.mjs rejected for symbols: it cannot generalise, and a hand-written
 * bundle.js is not minified. The MEASURED signal is the average line length: real source has
 * 30–80 chars per line; a minified file has thousands. The threshold (>500 chars/line on
 * average) sits well above the noisiest real source (a long URL or a generated config table)
 * and well below a minified bundle, so it does not flag prose and does not miss minification.
 *
 * NOT APPLIED TO CTAGS. ctags parses the language grammar, so minification does not confuse
 * it — it extracts every function regardless of line layout. This is a REGEX-FALLBACK guard
 * only, because that is the only path where line-orientation produces a wrong count.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isMinified(content) {
  if (!content) return false;
  const text = String(content);
  // A NUL byte means binary — not minified, just not text. Handled elsewhere (readTextIfSmall
  // returns null for binary), but defensive here in case a caller bypasses it.
  if (text.includes('\0')) return false;
  const lines = text.split('\n');
  // A file with no newlines at all and >500 chars is a single minified line.
  if (lines.length <= 1) return text.length > 500;
  // Average chars per line, excluding a trailing empty line from the split.
  const nonEmpty = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (nonEmpty === 0) return false;
  const avg = text.length / nonEmpty;
  return avg > 500;
}

/**
 * A human-readable warning for when minified files are detected in a scan.
 *
 * Exported so the scan/CLI can surface the SAME text. A second copy of a warning drifts, and
 * "these symbol counts are wrong because the file is minified" is the one a user acts on.
 *
 * @param {string[]} files  the minified file paths detected
 */
export function minifiedFilesWarning(files) {
  if (!files || !files.length) return null;
  const list = files.slice(0, 5).join(', ');
  const more = files.length > 5 ? ` (+${files.length - 5} more)` : '';
  return `holt: ${files.length} minified file(s) detected (${list}${more}). ` +
    'Symbol counts for these are unreliable under the regex fallback (a minified file is one ' +
    'long line, so line-oriented extraction misses most declarations). ' +
    'Install universal-ctags for accurate counts, or exclude minified files from the scan.';
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
  /** @type {any} */
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

// lstat for the same reason tagWorthy() lstats: this reads WORKTREE paths (symbolsOnDisk's
// fallback-extract and key-file branches do not go through ctagsBatch, so they need the guard
// independently), and stat() would follow a symlink and hand back the target's text as this
// path's own. See content-identity.mjs `pathContentKey` for the class.
async function readTextIfSmall(abs) {
  try {
    const stable = await readStableRegularFile(abs, { maxBytes: MAX_TEXT_BYTES });
    if (!stable.ok) return null;
    const buf = stable.bytes;
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

/**
 * A path that cannot be mistaken for a flag.
 *
 * ctags takes its input files as bare positional arguments, and a REPOSITORY controls its own
 * filenames. A file named `-L` is a legal filename and, handed to ctags positionally, is parsed as
 * ctags' own "read the list of files to scan from this file" option — which then consumes the NEXT
 * argument and opens whatever paths it finds INSIDE it. Reproduced against real ctags 6.2:
 *
 *     ctags ... -f - -L app.py
 *     ctags: Warning: cannot open input file "def ordinary(): pass"
 *
 * The contents of app.py became filenames. Pointed at a file listing a real path, ctags reads a
 * file outside the batch entirely and its source line comes back in the `pattern` field of the
 * JSON holt parses — so this is content disclosure from an attacker-named file, in a tool whose
 * whole premise is being pointed at repositories written by agents and pull requests.
 *
 * `--` IS NOT THE FIX and was tried: ctags rejects it outright with `Unknown option: --`. Prefixing
 * `./` is, because a leading `.` cannot begin an option and the path still resolves identically.
 * Absolute paths and Windows drive-qualified paths are already unambiguous and are left alone.
 */
export function argSafePath(p) {
  const s = String(p);
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('.\\')) return s;
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\')) return s;   // C:\... and UNC
  return `./${s}`;
}

// One `git cat-file --batch` process handles this many specs before holt starts a fresh one.
// There is no argv-length reason to chunk here (specs travel on stdin, not argv, unlike ctags'
// CTAGS chunking) — this bounds how much of the batch is lost if a single process hiccups
// (killed, OOM-killed, hits `timeout`) to one chunk's worth of files rather than the whole scan,
// while still cutting a 94,852-file union from 94,852 process spawns to ~19.
const CAT_FILE_BATCH_CHUNK = 5000;

/**
 * Symbols for files as they exist at `baseOid`.
 *
 * Blobs are materialised into a temp directory OUTSIDE the repository — never into the
 * user's tree — so one batched ctags run can cover them all. The temp dir is always removed.
 *
 * MEASURED: this used to spawn one `git cat-file -p <oid>:<rel>` PROCESS PER FILE (concurrency
 * 12). Profiled with --cpu-prof against a synthetic 40k-file repository with a 5,500-file
 * uncommitted delta: 64.7% of the scan's wall-clock time was inside `spawn` alone, almost all of
 * it this loop. Replaced with `catFileBatch()` (src/git.mjs) — ONE streaming `cat-file --batch`
 * process per chunk instead of one process per file. See BENCHMARKS.md for the before/after.
 */
export async function symbolsAtBase(repoRoot, baseOid, relPaths, backend) {
  const result = new Map();
  if (relPaths.length === 0) return result;

  const tmp = await fs.mkdtemp(path.join(scratchDir(), 'holt-base-'));
  try {
    const materialised = [];
    // Caches the MKDIR PROMISE, not a boolean. onRecord fires per record without waiting for the
    // previous one (drain() does not await it — that is the whole point of streaming), so two
    // records destined for the same directory can be in flight together. A boolean "already
    // requested" flag lets the second writer's `writeFile` race ahead of the first writer's
    // still-pending `mkdir` and fail ENOENT — reproduced while building this. Caching the promise
    // itself means every writer for a directory awaits the SAME single mkdir call.
    const dirReady = new Map();
    const ensureDir = (dir) => {
      let p = dirReady.get(dir);
      if (!p) {
        p = fs.mkdir(dir, { recursive: true });
        dirReady.set(dir, p);
      }
      return p;
    };

    for (let i = 0; i < relPaths.length; i += CAT_FILE_BATCH_CHUNK) {
      const group = relPaths.slice(i, i + CAT_FILE_BATCH_CHUNK);
      const specs = group.map((rel) => `${baseOid}:${rel}`);
      try {
        await catFileBatch(specs, { cwd: repoRoot }, async (_spec, content, idx) => {
          const rel = group[idx];
          if (content === null) { result.set(rel, []); return; } // absent at base = wholly new file
          try {
            const dest = path.join(tmp, rel);
            await ensureDir(path.dirname(dest));
            await fs.writeFile(dest, content);
            materialised.push(rel);
          } catch {
            // PER-RECORD CATCH: one file failing to materialise must not kill the entire chunk's
            // batch. The old form let a single writeFile rejection propagate through
            // Promise.all(inFlight) in catFileBatch, rejecting the whole batch and treating every
            // remaining file in the chunk as absent-at-base — losing symbol information for up to
            // CAT_FILE_BATCH_CHUNK files because of one bad path. Now the failure is scoped to the
            // one file: it is treated as absent-at-base (no symbols), and the rest of the chunk
            // proceeds normally.
            result.set(rel, []);
          }
        });
      } catch {
        // The whole CHUNK's batch process failed to run (spawn error, timeout). Same fallback
        // the old per-file call made on an individual failure: treat as absent-at-base rather
        // than crashing the scan. A read that could not happen is not evidence of anything.
        for (const rel of group) if (!result.has(rel)) result.set(rel, []);
      }
    }

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
/**
 * @param {{force?: string}} [opts]
 */
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
