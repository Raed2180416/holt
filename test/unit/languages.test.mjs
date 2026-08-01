/**
 * holt — language coverage, proven per language.
 *
 * A tool that claims to work on "any project" has to show it. Each case below is a real source
 * fragment with a symbol that MUST be found by name. This is presence-detection: a suite that
 * only asserted "no crash" would pass with an extractor that returns nothing for every language.
 *
 * The gap languages (Swift, Scala, Dart, Groovy, Solidity, Zig, Nim, Crystal, F#, Prolog,
 * Dockerfile, GraphQL) are included specifically because universal-ctags 6.2.1 reports
 * `--print-language: NONE` for all of them. If holt's optlib pack regresses, those cases fail
 * and nothing else does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { symbolsOnDisk, resolveBackend, detectCtags, ctagsLanguages, languageCoverage, compatReport } from '../../src/symbols.mjs';

/**
 * Filename -> the ctags LANGUAGE NAME that parses it, for the cases where a stock/older ctags may
 * lack the parser entirely. Only languages that have historically been absent from distro builds
 * need an entry; anything unlisted is assumed universally present and is always asserted.
 */
const CASE_LANGUAGE = {
  'a.tf': 'Terraform',
  'a.elm': 'Elm',
  'a.jl': 'Julia',
  'a.zig': 'Zig',
  'a.nim': 'Nim',
  'a.cr': 'Crystal',
  'a.sol': 'Solidity',
  'a.dart': 'Dart',
  'a.swift': 'Swift',
  'a.scala': 'Scala',
};

/** [filename, source, symbols that must be found] */
const CASES = [
  // --- ctags native ---------------------------------------------------------
  ['a.py', 'class PyThing:\n    def py_method(self):\n        return 1\n\ndef py_free(): pass\n', ['PyThing', 'py_method', 'py_free']],
  ['a.js', 'export function jsFn() {}\nexport class JsClass {}\nconst jsConst = 3;\n', ['jsFn', 'JsClass', 'jsConst']],
  ['a.ts', 'export interface TsIface { x: number }\nexport function tsFn(): void {}\n', ['TsIface', 'tsFn']],
  ['a.go', 'package m\n\nfunc GoFunc() int { return 1 }\n\ntype GoType struct{}\n', ['GoFunc', 'GoType']],
  ['a.rs', 'pub fn rust_fn() {}\npub struct RustStruct;\npub trait RustTrait {}\n', ['rust_fn', 'RustStruct', 'RustTrait']],
  ['a.java', 'public class JavaClass {\n  public int javaMethod() { return 1; }\n}\n', ['JavaClass', 'javaMethod']],
  ['a.rb', 'class RubyClass\n  def ruby_method\n  end\nend\n', ['RubyClass', 'ruby_method']],
  ['a.php', '<?php\nclass PhpClass {\n  public function phpMethod() {}\n}\n', ['PhpClass', 'phpMethod']],
  ['a.c', 'struct CStruct { int x; };\nint c_func(int a) {\n  return a;\n}\n', ['CStruct', 'c_func']],
  ['a.cpp', 'class CppClass {\npublic:\n  void cppMethod();\n};\n', ['CppClass', 'cppMethod']],
  ['a.cs', 'public class CsClass {\n  public void CsMethod() {}\n}\n', ['CsClass', 'CsMethod']],
  ['a.kt', 'class KtClass {\n  fun ktFun(): Int = 1\n}\n', ['KtClass', 'ktFun']],
  ['a.lua', 'function luaFunc()\nend\n', ['luaFunc']],
  ['a.pl6', 'sub perlSub { }\n', ['perlSub']],
  ['a.ex', 'defmodule ElixirMod do\n  def elixir_fun do\n  end\nend\n', ['ElixirMod', 'elixir_fun']],
  ['a.erl', '-module(erl_mod).\nerl_fun() -> ok.\n', ['erl_fun']],
  ['a.hs', 'haskellFn :: Int -> Int\nhaskellFn x = x\n', ['haskellFn']],
  ['a.jl', 'function juliaFn(x)\n    x\nend\n', ['juliaFn']],
  ['a.r', 'rFunc <- function(x) { x }\n', ['rFunc']],
  ['a.sh', 'shell_func() {\n  echo hi\n}\n', ['shell_func']],
  ['a.sql', 'CREATE TABLE sql_table (id INT);\n', ['sql_table']],
  ['a.tf', 'resource "aws_s3_bucket" "tf_bucket" {}\n', ['tf_bucket']],

  // --- ctags native, wave 2: toward the 50-language corpus -------------------
  ['a.ml', 'let ocaml_fn x = x + 1\n', ['ocaml_fn']],
  ['a.clj', '(defn clj_fn [x] x)\n', ['clj_fn']],
  ['a.scm', '(define (scheme_fn x) x)\n', ['scheme_fn']],
  ['a.pas', 'program hello;\nprocedure PascalProc;\nbegin\nend;\nbegin\nend.\n', ['PascalProc']],
  ['a.f90', 'subroutine fort_sub(x)\nend subroutine\n', ['fort_sub']],
  ['a.adb', 'procedure Ada_Proc is\nbegin\n  null;\nend Ada_Proc;\n', ['Ada_Proc']],
  ['a.vim', 'function! VimFunc()\nendfunction\n', ['VimFunc']],
  ['a.tcl', 'proc tcl_proc {x} { return $x }\n', ['tcl_proc']],
  ['a.sv', 'module sv_mod;\nendmodule\n', ['sv_mod']],
  ['a.vhd', 'entity vhdl_ent is\nend entity;\n', ['vhdl_ent']],
  ['a.proto', 'syntax = "proto3";\nmessage ProtoMsg { int32 xf = 1; }\n', ['ProtoMsg']],
  ['a.elm', 'elmFn : Int -> Int\nelmFn x = x\n', ['elmFn']],
  ['a.ps1', 'function PsFunc { return 1 }\n', ['PsFunc']],
  ['a.awk', 'function awk_fn(y) { return y }\n', ['awk_fn']],
  // Ambiguous extensions resolved by CONTENT (enry): .d and .m route through the classifier.
  ['a.d', 'int dlang_fn(int x) { return x; }\n', ['dlang_fn']],
  ['objc.m', '#import <Foundation/Foundation.h>\n@interface ObjcClass : NSObject\n@end\n', ['ObjcClass']],
  ['matlab.m', 'function y = matlab_fn(x)\n  y = x;\nend\n', ['matlab_fn']],

  // --- holt optlib gap pack ------------------------------------------------
  ['a.swift', 'public class SwiftClass {\n    func swiftMethod() -> Int { return 1 }\n}\n', ['SwiftClass', 'swiftMethod']],
  ['a.scala', 'class ScalaClass {\n  def scalaMethod(): Int = 1\n}\nobject ScalaObj\n', ['ScalaClass', 'scalaMethod', 'ScalaObj']],
  ['a.dart', 'class DartClass {\n  int dartMethod() => 1;\n}\n', ['DartClass', 'dartMethod']],
  ['a.groovy', 'class GroovyClass {\n  def groovyMethod() { }\n}\n', ['GroovyClass', 'groovyMethod']],
  ['a.sol', 'contract SolContract {\n  function solFunction() public {}\n  event SolEvent();\n}\n', ['SolContract', 'solFunction', 'SolEvent']],
  ['a.zig', 'pub fn zigFn() void {}\nconst ZigStruct = struct {};\n', ['zigFn', 'ZigStruct']],
  ['a.nim', 'proc nimProc(): int =\n  1\n', ['nimProc']],
  ['a.cr', 'class CrystalClass\n  def crystal_method\n  end\nend\n', ['CrystalClass', 'crystal_method']],
  ['a.fs', 'module FsModule\nlet fsFunction x = x\n', ['FsModule', 'fsFunction']],
  ['Dockerfile', 'FROM node:20 AS dockerStage\nARG DOCKER_ARG=1\n', ['dockerStage', 'DOCKER_ARG']],
  ['a.graphql', 'type GqlType {\n  id: ID!\n}\nquery GqlQuery { id }\n', ['GqlType', 'GqlQuery']],
];

test('ctags is available (every language assertion below depends on it)', async () => {
  const probe = await detectCtags();
  assert.equal(probe.available, true,
    `universal-ctags with JSON support is required for the language suite: ${probe.reason}`);
});

test('language coverage: every case yields its named symbols', async (t) => {
  const backend = await resolveBackend();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-lang-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const files = [];
  for (const [name, src] of CASES) {
    await fs.writeFile(path.join(dir, name), src, 'utf8');
    files.push(name);
  }

  const found = await symbolsOnDisk(dir, files, backend);

  // A language the INSTALLED ctags has no parser for is a toolchain gap, not a holt regression.
  // Distro packages lag badly (Ubuntu 24.04 ships 5.9.0, which has no Terraform or Elm parser),
  // so failing here would make the suite red on a correct build. Those cases are reported as
  // UNSUPPORTED-BY-THIS-CTAGS and asserted separately by the coverage-honesty test below —
  // everything the installed ctags CAN parse must still yield its symbols, or the suite goes red.
  // "Has no parser" must be DEMONSTRATED, not read off `--list-languages`. holt's optlib pack
  // loads cleanly on an older ctags, which then lists Terraform and Elm and extracts nothing from
  // either — so the declaration says supported while the parse says silent.
  const probe = await ctagsLanguages();
  const cov = await languageCoverage([...new Set(Object.values(CASE_LANGUAGE))]);
  const demonstrablyMissing = new Set(cov.available ? cov.missing : []);
  const unsupported = [];
  const failures = [];
  for (const [name, , expected] of CASES) {
    const lang = CASE_LANGUAGE[name];
    if (lang && probe.available && demonstrablyMissing.has(lang)) { unsupported.push(`${name} (${lang})`); continue; }
    const names = new Set((found.get(name) ?? []).map((s) => s.name));
    const missing = expected.filter((e) => !names.has(e));
    if (missing.length) {
      failures.push(`${name}: missing ${missing.join(', ')} (found: ${[...names].join(', ') || 'NOTHING'})`);
    }
  }

  if (unsupported.length) {
    t.diagnostic(`this ctags (${(await detectCtags()).version}) has no parser for: ${unsupported.join(', ')} — upgrade universal-ctags to cover them`);
  }
  assert.deepEqual(failures, [], `language coverage failures:\n${failures.join('\n')}`);
  // Presence-detection guard: if the probe were broken and skipped everything, this test would
  // pass vacuously. Require that the great majority actually ran.
  assert.ok(CASES.length - unsupported.length >= CASES.length - 6,
    `too many languages skipped (${unsupported.length}) — the suite would be proving nothing`);
});

test('language coverage: holt reports the gap between what it names and what this ctags supports', async () => {
  // The honesty mechanism itself. holt must never claim coverage the installed toolchain cannot
  // deliver: languageCoverage() names the missing parsers so `holt doctor` can surface them.
  const named = [...new Set(Object.values(CASE_LANGUAGE))];
  const cov = await languageCoverage(named);
  if (!cov.available) return; // no ctags at all — the regex-fallback path, covered elsewhere
  assert.equal(cov.checked, named.length);
  assert.equal(cov.supported + cov.missing.length, cov.checked, 'the accounting must balance');
  assert.ok(cov.note.length > 0, 'the report must always explain itself');
  if (cov.missing.length) {
    assert.match(cov.note, /upgrade universal-ctags/, 'a gap must tell the user how to close it');
  }
});

test('language coverage: the count is what we claim', async (t) => {
  const backend = await resolveBackend();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-langcount-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const files = [];
  for (const [name, src] of CASES) {
    await fs.writeFile(path.join(dir, name), src, 'utf8');
    files.push(name);
  }
  const found = await symbolsOnDisk(dir, files, backend);
  // Same capability rule as above: count only the languages this ctags can actually parse, so
  // an older toolchain reports an honest smaller number instead of failing a correct build.
  // Skip only what this toolchain DEMONSTRABLY cannot parse. `--list-languages` is a claim:
  // holt's optlib pack loads cleanly on an older ctags, which then lists Terraform and Elm and
  // extracts nothing from either. Asking the declaration made this test fail on a correct build
  // and, worse, made `holt doctor` promise coverage it could not deliver.
  const probe = await ctagsLanguages();
  const cov = await languageCoverage([...new Set(Object.values(CASE_LANGUAGE))]);
  const unsupported = new Set(cov.available ? cov.missing : []);
  const parseable = files.filter((f) => {
    const lang = CASE_LANGUAGE[f];
    return !(lang && probe.available && unsupported.has(lang));
  });
  const withSymbols = parseable.filter((f) => (found.get(f) ?? []).length > 0);

  assert.equal(withSymbols.length, parseable.length,
    `expected all ${parseable.length} parseable languages to yield symbols, got ${withSymbols.length}. ` +
    `Silent: ${files.filter((f) => !withSymbols.includes(f)).join(', ')}`);

  // ANTI-VACUITY. A capability-aware skip is one broken probe away from proving nothing: if the
  // demonstration returned "nothing is parseable", every case would skip and this test would pass
  // while measuring zero languages. The floor makes that failure loud instead of green.
  assert.ok(parseable.length >= CASES.length - 6,
    `only ${parseable.length}/${CASES.length} languages were exercised — the probe is broken, ` +
    `not your toolchain. Skipped: ${[...unsupported].join(', ')}`);
  assert.ok(withSymbols.length >= 40,
    `only ${withSymbols.length} languages yielded symbols — far below the shipped corpus`);
});

test('an unknown extension yields no symbols WITHOUT throwing', async (t) => {
  const backend = await resolveBackend();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-unknown-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dir, 'thing.zzzunknown'), 'some content here\n', 'utf8');
  const found = await symbolsOnDisk(dir, ['thing.zzzunknown'], backend);

  // Must be present as an entry with zero symbols — "scanned, found nothing" is a different
  // fact from "never scanned", and the map has to preserve the distinction.
  assert.ok(found.has('thing.zzzunknown'));
  assert.deepEqual(found.get('thing.zzzunknown'), []);
});

test('binary and oversized files are skipped, not misparsed', async (t) => {
  const backend = await resolveBackend();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-binary-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
  const found = await symbolsOnDisk(dir, ['blob.bin'], backend);
  assert.deepEqual(found.get('blob.bin'), []);
});

test('COMPAT: holt closes its toolchain\'s gaps instead of reporting them', async (t) => {
  // NEVER CONCEDE A LANGUAGE TO THE TOOLCHAIN. The version before this test measured that a ctags
  // could not parse Terraform or Elm and simply reported reduced coverage. On Ubuntu 24.04 LTS
  // (universal-ctags 5.9.0 — the most common Linux install) that means every .tf and .elm file
  // silently yields no symbols, and silence reads as "these two agents share nothing". A coverage
  // gap becomes a wrong ANSWER, not a smaller number.
  const backend = await resolveBackend();
  if (backend.kind !== 'ctags') return; // regex-fallback path is covered elsewhere

  const c = await compatReport();
  t.diagnostic(`compat: loaded ${c.loaded.length} pack(s); fixed [${c.fixed.join(', ') || 'none'}]`);

  assert.deepEqual(c.regressed ?? [], [],
    `a compat pack cost a language that already worked: ${(c.regressed ?? []).join(', ')} — ` +
    'never-worse is the floor, a pack that trades one language for another is refused');

  assert.deepEqual(c.stillMissing, [],
    `holt has no working definition for ${c.stillMissing.join(', ')} on this toolchain. ` +
    'Reporting the gap is not the answer — add src/optlib/compat/<Language>.ctags so the ' +
    'capability is restored rather than conceded.');
});

test('COMPAT: every pack is loadable by this ctags and defines what it claims', async () => {
  // A compat pack that ctags rejects would silently do nothing, and the gap it exists to close
  // would reappear as "coverage reduced" — the exact concession this mechanism removes.
  const backend = await resolveBackend();
  if (backend.kind !== 'ctags') return;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/optlib/compat');
  const packs = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.ctags'));
  assert.ok(packs.length > 0, 'the compat directory must not be empty — it is the mechanism');

  for (const pack of packs) {
    const { execFile } = await import('node:child_process');
    const r = await new Promise((res) => execFile('ctags',
      [`--options=${path.join(dir, pack)}`, '--list-languages'], { timeout: 8000 },
      (err, stdout, stderr) => res({ err, stdout, stderr })));
    // On a ctags that ALREADY has the language, --langdef collides and is expected to be refused;
    // that is exactly why holt loads a pack only after measuring the language to be missing.
    const collided = /already|defined|exists/i.test(String(r.stderr));
    assert.ok(!r.err || collided,
      `${pack} is not loadable by this ctags and is not a benign collision: ${r.stderr}`);
  }
});

test('PRECISION: a repeated package/namespace clause is not authored work', async () => {
  // MEASURED on a 1,000-pair labelled corpus: EVERY false positive holt produced was Go, and all
  // of them traced to one tag — ctags emits `package corpus` (kind "package") for the clause each
  // file in a Go package repeats verbatim. It counted as a symbol, so a NEW file in an existing
  // package looked like work found nowhere else, and two agents adding unrelated files to the same
  // package looked like they had built the same thing. Precision 96.5%; every miss was this.
  const backend = await resolveBackend();
  if (backend.kind !== 'ctags') return;
  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-container-'));
  try {
    await fs.writeFile(path.join(dir, 'a.go'), 'package corpus\n\nfunc AlphaFunc() int { return 1 }\n');
    await fs.writeFile(path.join(dir, 'b.go'), 'package corpus\n\nfunc BetaFunc() int { return 2 }\n');
    const found = await symbolsOnDisk(dir, ['a.go', 'b.go'], backend);
    const names = (f) => (found.get(f) ?? []).map((s) => s.name);

    assert.ok(names('a.go').includes('AlphaFunc'), 'the real function must still be found');
    assert.ok(names('b.go').includes('BetaFunc'), 'the real function must still be found');
    assert.ok(!names('a.go').includes('corpus'),
      `the package clause must not count as work: ${JSON.stringify(names('a.go'))}`);

    // The consequence that mattered: two files in one package share NOTHING.
    const shared = names('a.go').filter((n) => names('b.go').includes(n));
    assert.deepEqual(shared, [],
      `two files in the same Go package must share no symbols, got ${JSON.stringify(shared)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('PRECISION: a one-per-file module declaration IS work and must survive', async () => {
  // The line this filter must not cross. Go's `package` is restated by every file; F#'s
  // `module FsModule` names one thing once and a developer owns that name. An over-broad first
  // version of the filter excluded `module` too and made holt blind to real work in F#, Elixir and
  // Haskell — caught by the language suite, pinned here so it cannot come back.
  const backend = await resolveBackend();
  if (backend.kind !== 'ctags') return;
  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-module-'));
  try {
    await fs.writeFile(path.join(dir, 'm.fs'), 'module FsUniqueModule\nlet fsFn x = x\n');
    const found = await symbolsOnDisk(dir, ['m.fs'], backend);
    const names = (found.get('m.fs') ?? []).map((s) => s.name);
    assert.ok(names.includes('FsUniqueModule'),
      `a module a developer named and owns must count as work: ${JSON.stringify(names)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test('SYMBOLS: a namespaced file is not silently emptied — real code declares a namespace', async (t) => {
  // FOUND BY BENCHMARKING AGAINST REAL UPSTREAM FILES, and invisible to every fixture in this
  // suite before it. isNoise() dropped any tag whose ctags-reported `scope` contained a dot,
  // meaning to discard values nested inside a document. A dotted scope is ALSO exactly how ctags
  // renders an ordinary namespace: C# `namespace Newtonsoft.Json`, Kotlin
  // `package kotlin.collections`, Clojure `(ns clojure.string)`.
  //
  // Measured on real files from Newtonsoft.Json, JetBrains/kotlin and clojure/clojure: bare ctags
  // found 79, 105 and 22 tags; holt returned ZERO from each. Every symbol in virtually all real
  // code in those languages was discarded, silently, with no error anywhere - so collisions,
  // duplicates and impact were blind on them.
  //
  // It survived because the language fixtures are BARE ONE-LINERS that declare no namespace.
  // That is what a manufactured test looks like and what real code never does, which is why this
  // fixture wraps every sample in the namespace form its language actually uses.
  const { symbolsOnDisk, resolveBackend } = await import('../../src/symbols.mjs');
  const backend = await resolveBackend();
  if (!backend || backend.kind !== 'ctags') {
    return t.skip('ctags unavailable - the regex fallback does not model scope at all');
  }

  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR ?? os.tmpdir(), 'holt-ns-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const SAMPLES = [
    ['A.cs', 'namespace Acme.Billing\n{\n    public static class HoltInvoice\n    {\n        public static string RenderHoltTotal(object v) { return null; }\n    }\n}\n',
      ['HoltInvoice', 'RenderHoltTotal']],
    ['B.kt', 'package com.acme.billing\n\nfun computeHoltDiscount(x: Int): Int = x\n',
      ['computeHoltDiscount']],
    ['C.clj', '(ns acme.billing.core)\n(defn holt-normalise [s] s)\n',
      ['holt-normalise']],
  ];

  for (const [file, source] of SAMPLES) await fs.writeFile(path.join(dir, file), source);

  const got = await symbolsOnDisk(dir, SAMPLES.map(([f]) => f), backend);

  for (const [file, , expected] of SAMPLES) {
    const names = (got.get(file) ?? []).map((s) => s.name);
    for (const want of expected) {
      assert.ok(names.includes(want),
        `${file}: '${want}' is real authored work inside a namespace and must be extracted. ` +
        `Got: ${JSON.stringify(names)}`);
    }
  }

  // THE OTHER HALF - the noise the old rule was aiming at must still be filtered, or this fix
  // trades a false negative for the false-positive flood the IDF filter was built to stop.
  await fs.writeFile(path.join(dir, 'd.json'),
    '{ "meta": { "generatedAt": "x", "head": "y", "nested": { "count": 1 } } }\n');
  const json = await symbolsOnDisk(dir, ['d.json'], backend);
  const jsonNames = (json.get('d.json') ?? []).map((s) => s.name);
  assert.ok(!jsonNames.includes('generatedAt') && !jsonNames.includes('count'),
    `document values are not authored symbols: ${JSON.stringify(jsonNames)}`);
});
