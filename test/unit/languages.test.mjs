/**
 * grove — language coverage, proven per language.
 *
 * A tool that claims to work on "any project" has to show it. Each case below is a real source
 * fragment with a symbol that MUST be found by name. This is presence-detection: a suite that
 * only asserted "no crash" would pass with an extractor that returns nothing for every language.
 *
 * The gap languages (Swift, Scala, Dart, Groovy, Solidity, Zig, Nim, Crystal, F#, Prolog,
 * Dockerfile, GraphQL) are included specifically because universal-ctags 6.2.1 reports
 * `--print-language: NONE` for all of them. If grove's optlib pack regresses, those cases fail
 * and nothing else does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { symbolsOnDisk, resolveBackend, detectCtags } from '../../src/symbols.mjs';

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

  // --- grove optlib gap pack ------------------------------------------------
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-lang-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const files = [];
  for (const [name, src] of CASES) {
    await fs.writeFile(path.join(dir, name), src, 'utf8');
    files.push(name);
  }

  const found = await symbolsOnDisk(dir, files, backend);

  const failures = [];
  for (const [name, , expected] of CASES) {
    const names = new Set((found.get(name) ?? []).map((s) => s.name));
    const missing = expected.filter((e) => !names.has(e));
    if (missing.length) {
      failures.push(`${name}: missing ${missing.join(', ')} (found: ${[...names].join(', ') || 'NOTHING'})`);
    }
  }

  assert.deepEqual(failures, [], `language coverage failures:\n${failures.join('\n')}`);
});

test('language coverage: the count is what we claim', async (t) => {
  const backend = await resolveBackend();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-langcount-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const files = [];
  for (const [name, src] of CASES) {
    await fs.writeFile(path.join(dir, name), src, 'utf8');
    files.push(name);
  }
  const found = await symbolsOnDisk(dir, files, backend);
  const withSymbols = files.filter((f) => (found.get(f) ?? []).length > 0);

  assert.equal(withSymbols.length, CASES.length,
    `expected all ${CASES.length} languages to yield symbols, got ${withSymbols.length}. ` +
    `Silent: ${files.filter((f) => !withSymbols.includes(f)).join(', ')}`);
});

test('an unknown extension yields no symbols WITHOUT throwing', async (t) => {
  const backend = await resolveBackend();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-unknown-'));
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-binary-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
  const found = await symbolsOnDisk(dir, ['blob.bin'], backend);
  assert.deepEqual(found.get('blob.bin'), []);
});
