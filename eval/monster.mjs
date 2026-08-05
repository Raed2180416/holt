/**
 * holt — the MONSTER round.
 *
 * Builds the worst repository we know how to build — deliberately hard to follow, deliberately
 * hard to manage — then runs holt's complete loop against it and grades every verdict against
 * planted ground truth. This is the recursive stress instrument: every gap it finds becomes a
 * fix and a permanent test, then the monster runs again.
 *
 * WHAT MAKES IT A MONSTER (all at once, in one repo):
 *   - 80+ worktrees across FOUR languages (js/py/go/rs) with mixed prose and config
 *   - valuable work BURIED: one real file among heaps of junk; prose-only value; a one-line
 *     change; committed-ahead work on detached heads; work duplicated across exactly two trees
 *   - decoys: rich multi-commit history that base independently landed; names that lie in both
 *     directions (DELETEME holding gold, KEEP and IMPORTANT empty); recent mtimes on junk,
 *     ancient mtimes on gold
 *   - hazards: nested git repos, node_modules/dist heaps, binary blobs, deep paths, unicode
 *     names, names with spaces, a worktree named x.lock (detached), foreign-locked trees,
 *     broken registrations (directory deleted), gitignored-only content (a documented limit),
 *     empty-file-only trees, huge generated files
 *
 * GRADING IS THE POINT. For every planted item the script asserts holt's verdict; for the
 * destructive path it runs protect -> clean --apply -> rescue --release on a sample and
 * re-checks content survival by bytes. Exit non-zero on ANY wrong verdict.
 *
 *   node eval/monster.mjs [count] [--work DIR] [--out FILE] [--keep]
 *                                      # default 80 worktrees
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { discover } from '../src/discover.mjs';
import { scan } from '../src/scan.mjs';
import { analyze } from '../src/analyze.mjs';
import {
  protect,
  clean,
  rescue,
  quarantines,
  restoreQuarantine,
  purgeQuarantine,
} from '../src/actions.mjs';
import { ctagsLanguages, languageCoverage } from '../src/symbols.mjs';
import { findByPath, samePathAsync } from '../src/paths.mjs';
import { writeEvidenceArtifact } from './prep.mjs';

const ARGS = process.argv.slice(2);
const valueAfter = (name, fallback) => {
  const at = ARGS.indexOf(name);
  return at === -1 ? fallback : ARGS[at + 1];
};
const positionalCount = ARGS.find((arg, index) => (
  /^\d+$/.test(arg) && !['--work', '--out'].includes(ARGS[index - 1])
));
const COUNT = Math.max(20, Number(positionalCount ?? 80));
const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.resolve(valueAfter('--work', process.env.HOLT_MONSTER_WORK
  ?? path.join(os.homedir(), '.holt-work', 'holt-monster')));
const OUT = valueAfter('--out', null) ? path.resolve(valueAfter('--out', null)) : null;
const KEEP = ARGS.includes('--keep');
// Deliberately broken action seam used only by the pinned red-control test. A lifecycle oracle
// that still reports success when clean does nothing is not an oracle.
const MUTATE_NOOP_CLEAN = ARGS.includes('--test-mutate-noop-clean');
const WORK_MARKER = '.holt-monster-sandbox';
const WORK_MARKER_BODY = 'holt monster scratch v1\n';

if (!Number.isInteger(COUNT) || COUNT < 20) {
  throw new Error('monster count must be an integer >= 20');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

async function pathPresent(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function canonicalFuturePath(target) {
  let ancestor = path.resolve(target);
  const tail = [];
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      return path.resolve(real, ...tail.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function assertFreshEvidencePath(out = OUT) {
  if (!out) return;
  for (const candidate of [out, `${out}.sha256`]) {
    if (await pathPresent(candidate)) {
      throw new Error(`refusing to overwrite existing monster evidence: ${candidate}`);
    }
  }
}

async function prepareWorkRoot(root = WORK) {
  const st = await fs.lstat(root).catch(() => null);
  if (st?.isSymbolicLink()) throw new Error(`refusing symlink monster root: ${root}`);

  const [canonicalRoot, canonicalOut, canonicalHome, canonicalSource, canonicalCwd] = await Promise.all([
    canonicalFuturePath(root), OUT ? canonicalFuturePath(OUT) : null,
    canonicalFuturePath(os.homedir()), canonicalFuturePath(SOURCE_ROOT),
    canonicalFuturePath(process.cwd()),
  ]);
  const forbidden = new Set([
    path.parse(canonicalRoot).root, canonicalHome, canonicalSource, canonicalCwd,
  ]);
  const overlapsLiveTree = inside(canonicalRoot, canonicalSource) || inside(canonicalSource, canonicalRoot)
    || inside(canonicalRoot, canonicalCwd) || inside(canonicalCwd, canonicalRoot);
  if (forbidden.has(canonicalRoot) || overlapsLiveTree) {
    throw new Error(`refusing unsafe monster root: ${root}`);
  }
  if (canonicalOut && inside(canonicalOut, canonicalRoot)) {
    throw new Error(`--out must be outside --work; cleanup would erase the only evidence (${OUT})`);
  }

  if (st) {
    if (!st.isDirectory()) throw new Error(`refusing non-directory monster root: ${root}`);
    const marker = await fs.readFile(path.join(root, WORK_MARKER), 'utf8').catch(() => null);
    if (marker !== WORK_MARKER_BODY) {
      throw new Error(`refusing to replace ${root}: it lacks Holt's exact ${WORK_MARKER} ownership marker`);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, WORK_MARKER), WORK_MARKER_BODY, { encoding: 'utf8', flag: 'wx' });
}

async function cleanWorkRoot(root = WORK) {
  if (KEEP) return { requested: false, removed: false, retained: true, error: null };
  const marker = await fs.readFile(path.join(root, WORK_MARKER), 'utf8').catch(() => null);
  if (marker !== WORK_MARKER_BODY) {
    throw new Error(`refusing cleanup: ${root} no longer has Holt's exact ${WORK_MARKER} ownership marker`);
  }
  await fs.rm(root, { recursive: true, force: true });
  return { requested: true, removed: true, retained: false, error: null };
}

async function sourceIdentity() {
  const files = [];
  const visit = async (absolute, relative) => {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      files.push({ relative, kind: 'symlink', target: await fs.readlink(absolute) });
      return;
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(absolute, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        await visit(path.join(absolute, entry.name), path.join(relative, entry.name));
      }
      return;
    }
    if (stat.isFile()) files.push({ relative, kind: 'file', bytes: await fs.readFile(absolute) });
  };
  for (const relative of ['bin', 'src', 'eval/monster.mjs', 'eval/prep.mjs', 'package.json', 'package-lock.json']) {
    await visit(path.join(SOURCE_ROOT, relative), relative);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of files.sort((a, b) => a.relative.localeCompare(b.relative))) {
    hash.update(file.relative.split(path.sep).join('/')).update('\0').update(file.kind).update('\0');
    if (file.kind === 'file') {
      hash.update(file.bytes);
      bytes += file.bytes.length;
    } else hash.update(file.target);
    hash.update('\0');
  }
  const [head, status] = await Promise.all([
    sh('git', ['rev-parse', 'HEAD'], SOURCE_ROOT),
    sh('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], SOURCE_ROOT),
  ]);
  if (head.code !== 0 || status.code !== 0) throw new Error('could not identify monster source tree');
  return {
    root: SOURCE_ROOT,
    head: head.stdout.trim(),
    dirty: status.stdout.length > 0,
    dirtyStateSha256: sha256(status.stdout),
    runtimeAndEvaluatorSha256: hash.digest('hex'),
    files: files.length,
    bytes,
  };
}

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      // No evaluator deadline: an outer operator may cancel, but a slow valid fixture is not a
      // synthetic product failure.
      cwd, maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@m', GIT_COMMITTER_NAME: 'm',
        GIT_COMMITTER_EMAIL: 'm@m', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

async function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

function parseWorktreePorcelainZ(raw) {
  const records = [];
  let record = null;
  const finish = () => {
    if (record) records.push(record);
    record = null;
  };
  for (const field of String(raw).split('\0')) {
    if (!field) {
      finish();
      continue;
    }
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? true : field.slice(space + 1);
    if (key === 'worktree') {
      finish();
      record = { path: value, head: null, branch: null, detached: false, locked: false, lockReason: null };
      continue;
    }
    if (!record) throw new Error(`malformed git worktree porcelain field before worktree: ${field}`);
    if (key === 'HEAD') record.head = value;
    else if (key === 'branch') record.branch = value;
    else if (key === 'detached') record.detached = true;
    else if (key === 'locked') {
      record.locked = true;
      record.lockReason = value === true ? '' : value;
    } else if (key === 'prunable') record.prunable = value === true ? '' : value;
  }
  finish();
  return records;
}

async function registeredWorktrees(root) {
  const listed = await sh('git', ['worktree', 'list', '--porcelain', '-z'], root);
  if (listed.code !== 0) {
    throw new Error(`could not independently inventory registered worktrees: ${listed.stderr.trim()}`);
  }
  const records = parseWorktreePorcelainZ(listed.stdout);
  const duplicates = [];
  for (let index = 0; index < records.length; index++) {
    for (let prior = 0; prior < index; prior++) {
      if (await samePathAsync(records[index].path, records[prior].path)) {
        duplicates.push(records[index]);
        break;
      }
    }
  }
  if (duplicates.length) throw new Error('git worktree porcelain returned duplicate registered paths');
  return records;
}

async function registeredAt(records, target) {
  return await findByPath(records, target) ?? null;
}

/**
 * Hash the complete user-visible worktree, including ignored/untracked bytes, symlink targets,
 * empty directories, and permission modes. `.git` is the one exclusion: Git rewrites that
 * administrative pointer when moving a worktree, and HEAD/branch/index/status are measured
 * independently below.
 */
async function workingTreeManifest(root) {
  const leaves = [];
  const visit = async (absolute, relative) => {
    const stat = await fs.lstat(absolute);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      leaves.push({ relative, kind: 'symlink', mode, target: await fs.readlink(absolute) });
      return;
    }
    if (stat.isDirectory()) {
      leaves.push({ relative, kind: 'directory', mode });
      const entries = (await fs.readdir(absolute, { withFileTypes: true }))
        .filter((entry) => !(relative === '' && entry.name === '.git'))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        await visit(path.join(absolute, entry.name), path.join(relative, entry.name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`unsupported filesystem object in worktree: ${absolute}`);
    const bytes = await fs.readFile(absolute);
    leaves.push({
      relative,
      kind: 'file',
      mode,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  };
  await visit(root, '');
  leaves.sort((a, b) => a.relative.localeCompare(b.relative));
  const encoded = JSON.stringify(leaves);
  return {
    sha256: sha256(encoded),
    entries: leaves.length,
    files: leaves.filter((leaf) => leaf.kind === 'file').length,
    directories: leaves.filter((leaf) => leaf.kind === 'directory').length,
    symlinks: leaves.filter((leaf) => leaf.kind === 'symlink').length,
    bytes: leaves.reduce((sum, leaf) => sum + (leaf.bytes ?? 0), 0),
    leaves,
  };
}

async function worktreeIdentity(target) {
  const stat = await fs.lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return { present: false, path: target };
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`worktree root is not a physical directory: ${target}`);
  }
  const [head, branch, index, status, manifest] = await Promise.all([
    sh('git', ['rev-parse', '--verify', 'HEAD^{commit}'], target),
    sh('git', ['symbolic-ref', '--quiet', 'HEAD'], target),
    sh('git', ['ls-files', '--stage', '-z'], target),
    sh('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], target),
    workingTreeManifest(target),
  ]);
  if (head.code !== 0 || index.code !== 0 || status.code !== 0 || ![0, 1].includes(branch.code)) {
    throw new Error(`could not capture exact Git/worktree identity at ${target}`);
  }
  return {
    present: true,
    path: target,
    head: head.stdout.trim(),
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    detached: branch.code !== 0,
    indexSha256: sha256(index.stdout),
    indexBytes: Buffer.byteLength(index.stdout),
    statusSha256: sha256(status.stdout),
    statusBytes: Buffer.byteLength(status.stdout),
    manifest,
  };
}

function sameWorktreeIdentity(before, after) {
  return before?.present === true && after?.present === true
    && before.head === after.head
    && before.branch === after.branch
    && before.detached === after.detached
    && before.indexSha256 === after.indexSha256
    && before.statusSha256 === after.statusSha256
    && before.manifest.sha256 === after.manifest.sha256;
}

function identityMismatch(before, after) {
  if (!before?.present || !after?.present) return `presence ${before?.present} -> ${after?.present}`;
  const changed = [];
  for (const key of ['head', 'branch', 'detached', 'indexSha256', 'statusSha256']) {
    if (before[key] !== after[key]) changed.push(key);
  }
  if (before.manifest?.sha256 !== after.manifest?.sha256) changed.push('filesystem manifest');
  return changed.join(', ') || 'unknown identity difference';
}

async function exactFileIdentity(target) {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`expected physical file: ${target}`);
  const bytes = await fs.readFile(target);
  return { bytes: bytes.length, mode: stat.mode & 0o7777, sha256: sha256(bytes) };
}

function plantedCategories(truth) {
  const categories = new Map();
  const add = (id, category) => {
    if (!categories.has(id)) categories.set(id, []);
    categories.get(id).push(category);
  };
  for (const id of truth.mustSurvive.keys()) add(id, 'must-survive');
  for (const id of truth.disposable) add(id, 'disposable');
  for (const id of truth.generatedOnly) add(id, 'generated-looking-unverified');
  for (const [a, b] of truth.eitherNotBoth) {
    add(a, 'duplicate-pair');
    add(b, 'duplicate-pair');
  }
  for (const id of truth.unknownExpected) add(id, 'unknown');
  for (const id of truth.foreignLocked) add(id, 'foreign-locked');
  for (const id of truth.gitignoredOnly) add(id, 'gitignored-only');
  for (const id of truth.gold50.keys()) add(id, 'gold50');
  for (const [role, id] of Object.entries(truth.lifecycle)) add(id, `lifecycle:${role}`);
  return categories;
}

function reportNode(report, id) {
  return report.graph.nodes.find((node) => (
    node.id === id || node.id?.endsWith(`/${id}`) || path.basename(node.path ?? '') === id
  )) ?? null;
}

function reportVerdict(report, id) {
  return report.safe.find((verdict) => (
    verdict.id === id || verdict.id?.endsWith(`/${id}`)
  )) ?? null;
}

async function capturePlantedLifecycle(root, report, truth) {
  const registry = await registeredWorktrees(root);
  const categories = plantedCategories(truth);
  const records = [];
  for (const [id, kinds] of [...categories].sort(([a], [b]) => a.localeCompare(b))) {
    const node = reportNode(report, id);
    const fallbackRegistrations = registry.filter((entry) => path.basename(entry.path) === id);
    const originalPath = node?.path ?? (fallbackRegistrations.length === 1
      ? fallbackRegistrations[0].path
      : null);
    if (!originalPath) throw new Error(`planted lifecycle id has no unique report/registration path: ${id}`);
    const registration = await registeredAt(registry, originalPath);
    if (!registration) throw new Error(`planted lifecycle id has no Git registration: ${id}`);
    const before = await worktreeIdentity(originalPath);
    const verdict = reportVerdict(report, id);
    const expectedDisposition = truth.unknownExpected.has(id)
      ? 'unknown-retained'
      : truth.foreignLocked.has(id)
        ? 'foreign-lock-retained'
        : (truth.disposable.has(id) || verdict?.safe === true)
          ? 'quarantine'
          : 'active-retained';
    let atomicFile = null;
    const spec = truth.mustSurvive.get(id);
    if (before.present && spec?.[0]) {
      atomicFile = { relativePath: spec[0], ...await exactFileIdentity(path.join(originalPath, spec[0])) };
    }
    records.push({
      id,
      categories: [...new Set(kinds)].sort(),
      expectedDisposition,
      originalPath,
      verdict: verdict ? {
        id: verdict.id,
        safe: verdict.safe,
        confidence: verdict.confidence ?? null,
        reasons: verdict.reasons ?? [],
      } : null,
      registrationBefore: registration,
      before,
      atomicFile,
      cleanAction: null,
      afterClean: null,
      exactAfterClean: null,
      terminal: null,
    });
  }
  return records;
}


/**
 * GOLD50 — the full 50-language corpus, embedded from test/unit/languages.test.mjs so the
 * monster buries valuable work in EVERY language holt claims. Each entry's first symbol name
 * doubles as the byte marker; grading asserts (a) the verdict is not-safe, (b) the bytes
 * survive the destructive loop, and (c) the SYMBOL layer itself flagged the tree — so a
 * language whose extractor silently regressed fails the monster, not just the unit corpus.
 */
const GOLD50 = [
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

const LANGS = [
  { ext: 'js', fn: (n, i) => `export function ${n}() { return ${i}; }\n` },
  { ext: 'py', fn: (n, i) => `def ${n}():\n    return ${i}\n` },
  { ext: 'go', fn: (n, i) => `package m\n\nfunc ${n}() int { return ${i} }\n` },
  { ext: 'rs', fn: (n, i) => `pub fn ${n}() -> i32 { ${i} }\n` },
];

/** Junk heap: what agent runs actually leave behind. */
async function heapJunk(wt, i) {
  for (let j = 0; j < 6; j++) {
    await write(wt, `node_modules/dep${j}/index.js`, `module.exports=${j};\n`);
  }
  await write(wt, 'dist/bundle.min.js', `console.log(${'0,'.repeat(2000)}0);\n`);
  await write(wt, `logs/run-${i}.log`, `${'noise\n'.repeat(200)}`);
  // These paths LOOK like junk, which is precisely why they are adversarial. A manifest can show
  // how a directory is normally recreated; it cannot prove these exact bytes contain no hand
  // patch, incident evidence or one-off output. The oracle therefore requires preservation unless
  // a durable exact copy exists.
  await write(wt, '.cache/blob.bin', Buffer.alloc(4096, i % 256));
}

async function main() {
  console.log(`holt MONSTER · ${COUNT} worktrees · every trap at once\n`);
  await assertFreshEvidencePath();
  const startedAt = new Date().toISOString();
  const sourceBefore = await sourceIdentity();
  await prepareWorkRoot();
  if (OUT) await fs.mkdir(path.dirname(OUT), { recursive: true });
  const root = path.join(WORK, 'repo');
  await fs.mkdir(root, { recursive: true });

  // A real-ish polyglot base: 120 files.
  await sh('git', ['init', '-q', '--initial-branch=main'], root);
  for (let i = 0; i < 30; i++) {
    for (const L of LANGS) await write(root, `src/${L.ext}/mod_${i}.${L.ext}`, L.fn(`base_${L.ext}_${i}`, i));
  }
  await write(root, '.gitignore', 'secret-cache/\nnode_modules/\ndist/\nlogs/\n*.bin\n');
  // A package.json is useful provenance about conventional output directories, but is not exact
  // recovery evidence for their present bytes. It deliberately remains in the fixture so the
  // monster catches any regression that turns manifest presence into deletion authority.
  await write(root, 'package.json', JSON.stringify({ name: 'monster', private: true }));
  await write(root, 'README.md', '# monster\n');
  await sh('git', ['add', '-A'], root);
  await sh('git', ['commit', '-q', '-m', 'base'], root);
  const base = (await sh('git', ['rev-parse', 'HEAD'], root)).stdout.trim();

  const wtRoot = path.join(WORK, 'trees');
  await fs.mkdir(wtRoot, { recursive: true });

  const truth = {
    mustSurvive: new Map(),   // id -> [relPath, byteMarker]
    disposable: new Set(),
    generatedOnly: new Set(), // generated-looking is a hint, never proof that exact bytes recover
    eitherNotBoth: [],        // [idA, idB, marker]
    unknownExpected: new Set(),
    foreignLocked: new Set(),
    gitignoredOnly: new Set(), // holt cannot VERIFY ignored content -> must REFUSE, never disposable
    gold50: new Map(),         // id -> symbol that the SYMBOL layer must itself flag
    gold50Corpus: new Map(),   // id -> exact GOLD50 snippet index/file for denominator evidence
    gold50Lang: new Map(),     // id -> ctags language name, so an older ctags is reported not failed
    lifecycle: {
      restore: 'lifecycle-restore',
      purge: 'lifecycle-purge',
      dirtyPurgeRefusal: 'lifecycle-dirty-purge-refusal',
      purgeRace: 'lifecycle-purge-race',
    },
  };

  const mk = async (name, { branch = false } = {}) => {
    const p = path.join(wtRoot, name);
    const args = branch
      ? ['worktree', 'add', '-q', '-b', `wt/${name.replace(/[^A-Za-z0-9._-]/g, '_')}`, p, base]
      : ['worktree', 'add', '-q', '--detach', p, base];
    const r = await sh('git', args, root);
    if (r.code !== 0) throw new Error(`worktree add ${name}: ${r.stderr}`);
    return p;
  };

  let n = 0;
  const nextLang = () => LANGS[n % LANGS.length];

  while (n < COUNT) {
    const kind = (n % 3 === 2) ? 14 : (n % 16);
    const L = nextLang();
    const id = (() => {
      // Names that lie, names that hurt.
      if (kind === 0) return `DELETEME-junk-${n}`;
      if (kind === 1) return `IMPORTANT-do-not-delete-${n}`;
      if (kind === 2) return `wt space ${n}`;
      if (kind === 3) return `ünïcode-${n}`;
      return `agent-run-${1000 + n}`;
    })();

    const wt = await mk(id, { branch: kind === 5 });

    switch (kind) {
      case 0: { // alarming name, buried gold: one real file under a junk heap
        await heapJunk(wt, n);
        const marker = `BURIED_GOLD_${n}`;
        await write(wt, `src/${L.ext}/gold_${n}.${L.ext}`, L.fn(marker, n));
        truth.mustSurvive.set(id, [`src/${L.ext}/gold_${n}.${L.ext}`, marker]);
        break;
      }
      case 1: { // reassuring name, nothing but junk
        await heapJunk(wt, n);
        truth.generatedOnly.add(id);
        break;
      }
      case 2: { // space in name + prose-only value (symbol layer skips prose by design)
        const marker = `prose irreplaceable ${n}`;
        await write(wt, 'notes/decision.md', `# decision\n${marker}\n`);
        truth.mustSurvive.set(id, ['notes/decision.md', marker]);
        break;
      }
      case 3: { // unicode name + unicode symbols
        const marker = `unicode_wörk_${n}`;
        await write(wt, `src/üni_${n}.js`, `export function ${marker}() { return 1; }\n`);
        truth.mustSurvive.set(id, [`src/üni_${n}.js`, marker]);
        break;
      }
      case 4: { // committed-ahead on detached head
        const marker = `ahead_${L.ext}_${n}`;
        await write(wt, `src/${L.ext}/a_${n}.${L.ext}`, L.fn(marker, n));
        await sh('git', ['add', '-A'], wt);
        await sh('git', ['commit', '-q', '-m', `ahead ${n}`], wt);
        truth.mustSurvive.set(id, [`src/${L.ext}/a_${n}.${L.ext}`, marker]);
        break;
      }
      case 5: { // landed decoy with RICH history (4 commits), base independently has it all
        const marker = `landed_${n}`;
        const rel = `src/${L.ext}/l_${n}.${L.ext}`;
        for (let c = 0; c < 3; c++) {
          await write(wt, rel, L.fn(marker, c));
          await sh('git', ['add', '-A'], wt);
          await sh('git', ['commit', '-q', '-m', `iter ${c}`], wt);
        }
        const final = L.fn(marker, 99);
        await write(wt, rel, final);
        await sh('git', ['add', '-A'], wt); await sh('git', ['commit', '-q', '-m', 'final'], wt);
        await write(root, rel, final);
        await sh('git', ['add', '-A'], root); await sh('git', ['commit', '-q', '-m', `land ${n}`], root);
        truth.disposable.add(id);
        break;
      }
      case 6: { // duplicated across exactly two trees — either may go, not both
        const marker = `twin_${n}`;
        const body = L.fn(marker, n);
        await write(wt, `src/twin_${n}.${L.ext}`, body);
        const id2 = `agent-run-${1000 + n}-b`;
        const wt2 = await mk(id2);
        await write(wt2, `src/twin_${n}.${L.ext}`, body);
        truth.eitherNotBoth.push([id, id2, marker]);
        n++; // consumed an extra slot
        break;
      }
      case 7: { // nested git repo + real value beside it
        await sh('git', ['init', '-q'], path.join(wt, 'vendor/inner'));
        await write(wt, 'vendor/inner/inner.txt', 'INNER\n');
        const marker = `beside_nested_${n}`;
        await write(wt, `src/${L.ext}/b_${n}.${L.ext}`, L.fn(marker, n));
        truth.mustSurvive.set(id, [`src/${L.ext}/b_${n}.${L.ext}`, marker]);
        break;
      }
      case 8: { // gitignored-only content — holt must REFUSE, because it cannot verify it
        // This fixture used to assert the opposite ("documented limit: holt must call it
        // disposable"), and that ground truth is what let the defect ship. `git status
        // --ignored=matching` collapses an ignored subtree to one entry with a trailing slash,
        // holt skipped those, and a worktree whose only unique content was `secret-cache/…` came
        // back provably disposable — `clean --apply` then deleted the only copy. Measured 40/40
        // on a 2,440-worktree corpus, with live credentials as the payload.
        //
        // Unverifiable is not safe. Refusing costs one manual deletion; the old truth cost the file.
        await write(wt, 'secret-cache/only-here.txt', `IGNORED_${n}\n`);
        truth.gitignoredOnly.add(id);
        break;
      }
      case 9: { // foreign lock on a junk tree — clean must skip it, unprotect must not touch it
        await heapJunk(wt, n);
        await sh('git', ['worktree', 'lock', '--reason', `human: kept for audit ${n}`, wt], root);
        truth.foreignLocked.add(id);
        break;
      }
      case 10: { // broken registration: directory deleted underneath git
        await write(wt, 'src/gone.js', 'export function GONE() {}\n');
        await fs.rm(wt, { recursive: true, force: true });
        truth.unknownExpected.add(id);
        break;
      }
      case 11: { // one-line change to a tracked file, buried under junk
        await heapJunk(wt, n);
        const marker = `ONE_LINE_${n}`;
        await write(wt, 'README.md', `# monster\n<!-- ${marker} -->\n`);
        truth.mustSurvive.set(id, ['README.md', marker]);
        break;
      }
      case 12: { // deep path + config-format value (yaml keys, not code symbols)
        const marker = `deep_key_${n}`;
        const deep = Array.from({ length: 14 }, (_, i2) => `d${i2}`).join('/');
        await write(wt, `${deep}/routes.yaml`, `routes:\n  - name: ${marker}\n    path: /x\n`);
        truth.mustSurvive.set(id, [`${deep}/routes.yaml`, marker]);
        break;
      }
      case 13: { // uncommitted DELETION of tracked files — a decision, not disposable
        await fs.rm(path.join(wt, 'src/js/mod_0.js'), { force: true });
        await fs.rm(path.join(wt, 'src/py/mod_1.py'), { force: true });
        truth.mustSurvive.set(id, [null, null]); // nothing to find; must simply not be "safe"
        break;
      }
      case 14: { // GOLD50: buried valuable work in one of the 50 languages, round-robin
        const corpusIndex = n % GOLD50.length;
        const [fname, body, symbols] = GOLD50[corpusIndex];
        await heapJunk(wt, n);
        // Instantiate the snippet with a per-tree suffix: round-robin repeats a language once
        // n exceeds 50, and two trees planting the SAME symbol makes it correctly non-unique —
        // the first run of this grader asserted uniqueness anyway and manufactured 4 false
        // failures. The suffix keeps every planted symbol genuinely unique. (The fifth failure
        // was real: Dockerfile name variants had no parser mapping.)
        const uniqSym = `${symbols[0]}_${n}`;
        const instantiated = body.split(symbols[0]).join(uniqSym);
        const rel = `gold50/g${n}/${fname}`; // per-tree DIR keeps realistic basenames — g98_Dockerfile is nobody's real filename; Dockerfile under a subdir is everyone's
        await write(wt, rel, instantiated);
        truth.mustSurvive.set(id, [rel, uniqSym]);
        truth.gold50.set(id, uniqSym);
        truth.gold50Corpus.set(id, { corpusIndex, file: fname });
        const langOf = { 'a.tf': 'Terraform', 'a.elm': 'Elm', 'a.jl': 'Julia', 'a.zig': 'Zig', 'a.nim': 'Nim', 'a.cr': 'Crystal', 'a.sol': 'Solidity', 'a.dart': 'Dart', 'a.swift': 'Swift', 'a.scala': 'Scala' };
        if (langOf[fname]) truth.gold50Lang.set(id, langOf[fname]);
        break;
      }
      default: { // genuinely spent: junk only or empty
        if (n % 2) {
          await heapJunk(wt, n);
          truth.generatedOnly.add(id);
        } else truth.disposable.add(id);
      }
    }
    n++;
  }

  // The x.lock hostile name, detached (git refuses .lock in branch names).
  {
    const p = path.join(wtRoot, 'x.lock');
    await sh('git', ['worktree', 'add', '-q', '--detach', p, base], root);
    await write(p, 'src/hostile.js', 'export function HOSTILE_LOCKNAME() {}\n');
    truth.mustSurvive.set('x.lock', ['src/hostile.js', 'HOSTILE_LOCKNAME']);
  }

  // Stable, clean lifecycle controls. The random corpus may contain disposable worktrees, but
  // these four names make restore, successful purge, dirty-quarantine refusal, and the final
  // remove race mandatory on every Monster size. The purge control carries a branch so the oracle
  // can prove physical checkout reclamation does not erase branch reachability.
  for (const [role, id] of Object.entries(truth.lifecycle)) {
    await mk(id, { branch: role === 'purge' });
    truth.disposable.add(id);
  }

  const total = (await sh('git', ['worktree', 'list'], root)).stdout.trim().split('\n').length - 1;
  console.log(`  built ${total} worktrees\n`);

  /* ---------------------------------------------------------------- grade ---- */
  const t0 = Date.now();
  const disc = await discover(root);
  const scanned = await scan(disc, {});
  const report = await analyze(scanned, {});
  const scanAnalyzeMs = Date.now() - t0;
  console.log(`  scan+analyze  ${scanAnalyzeMs}ms for ${report.counts.workstreams} workstreams`);

  const errors = [];
  const verdictOf = (id) => report.safe.find((s) => s.id === id || s.id.endsWith(`/${id}`));

  for (const [id] of truth.mustSurvive) {
    const v = verdictOf(id);
    if (!v) { errors.push(`${id}: MISSING from report`); continue; }
    if (v.safe) errors.push(`${id}: holds irreplaceable content but holt says SAFE`);
  }
  for (const id of truth.disposable) {
    const v = verdictOf(id);
    if (!v) { errors.push(`${id}: MISSING from report`); continue; }
    if (!v.safe && !truth.foreignLocked.has(id)) {
      errors.push(`${id}: planted disposable but holt refuses (${v.reasons.join('; ')})`);
    }
  }
  for (const [label, ids] of [
    ['generated-looking bytes without an exact durable copy', truth.generatedOnly],
    ['unverifiable ignored bytes', truth.gitignoredOnly],
  ]) {
    for (const id of ids) {
      const v = verdictOf(id);
      if (!v) { errors.push(`${id}: MISSING from report`); continue; }
      if (v.safe) errors.push(`${id}: ${label} but holt says SAFE`);
    }
  }
  for (const id of truth.unknownExpected) {
    const v = verdictOf(id);
    if (!v) { errors.push(`${id}: broken registration vanished from report entirely`); continue; }
    if (v.safe) errors.push(`${id}: unassessable but called SAFE (fail-open)`);
  }
  for (const [a, b] of truth.eitherNotBoth) {
    const va = verdictOf(a); const vb = verdictOf(b);
    if (va?.safe && vb?.safe) errors.push(`${a}+${b}: duplicated pair BOTH called safe — deleting both loses the work`);
  }

  // GOLD50: the SYMBOL layer itself must have flagged these — byte survival alone would let a
  // silently-regressed language extractor hide behind the file layer.
  // Capability-aware: a language the INSTALLED ctags has no parser for is a toolchain gap, not a
  // holt regression (Ubuntu 24.04 ships ctags 5.9.0 — no Terraform/Elm parser). Those trees are
  // reported as unsupported rather than counted as misses, so a correct build is never red on an
  // older toolchain — while every language this ctags CAN parse must still be detected.
  // DEMONSTRATED, not declared. holt's optlib pack loads cleanly on an older ctags, which then
  // LISTS Terraform and Elm and extracts nothing from either — so asking `--list-languages`
  // counted those trees as misses and turned a correct build red.
  const langProbe = await ctagsLanguages();
  const cov = await languageCoverage([...new Set(truth.gold50Lang?.values() ?? [])]);
  const unparseable = new Set(cov.available ? cov.missing : []);
  let goldSeen = 0;
  let goldUnsupported = 0;
  for (const [id, sym] of truth.gold50) {
    const u = report.unique.find((x) => x.id === id || x.id.endsWith(`/${id}`));
    if (!u) { errors.push(`${id}: gold50 tree missing from unique report`); continue; }
    const names = [...u.byLayer.uncommitted, ...u.byLayer.untracked, ...u.byLayer.committed].map((x) => x.key);
    if (!names.some((k) => k.endsWith(`:${sym}`))) {
      const lang = truth.gold50Lang?.get(id);
      if (lang && langProbe.available && unparseable.has(lang)) { goldUnsupported++; continue; }
      errors.push(`${id}: SYMBOL LAYER MISSED ${sym} — language extractor regressed for this tree`);
    } else goldSeen++;
  }
  console.log(`  gold50 symbol-layer detections: ${goldSeen}/${truth.gold50.size - goldUnsupported}`
    + (goldUnsupported ? `  (${goldUnsupported} skipped: no parser in this ctags)` : ''));
  console.log(`  diagnostic verdicts: ${errors.length === 0 ? 'ALL CORRECT' : errors.length + ' WRONG'}`);
  // NAME THEM. A grader that reports "4 WRONG" and stops is a grader you cannot act on — the
  // count tells you something broke and nothing about what, so the next step is always to go and
  // re-instrument it. Printing the errors costs nothing and removes that step entirely.
  for (const e of errors) console.log(`      ! ${e}`);
  const diagnosticErrors = [...errors];

  /* ------------------------------------------------- the destructive loop ---- */
  const destructiveStarted = Date.now();
  const lifecycleRecords = await capturePlantedLifecycle(root, report, truth);
  const lifecycleById = new Map(lifecycleRecords.map((record) => [record.id, record]));
  if (lifecycleRecords.length !== total) {
    errors.push(`lifecycle oracle classified ${lifecycleRecords.length}/${total} built worktrees`);
  }
  const p = await protect(root, {});
  console.log(`  protect: locked ${p.protected}, unknown ${p.unknown.length}, failed ${p.failed}`);
  if (p.failed !== 0) errors.push(`protect reported ${p.failed} unexpected failure(s)`);
  const expectedUnknown = [...truth.unknownExpected].sort();
  const protectUnknown = p.unknown.map((entry) => entry.id).sort();
  if (JSON.stringify(protectUnknown) !== JSON.stringify(expectedUnknown)) {
    errors.push(`protect unknown set ${JSON.stringify(protectUnknown)} != planted ${JSON.stringify(expectedUnknown)}`);
  }

  let c;
  if (MUTATE_NOOP_CLEAN) {
    const preview = await clean(root, { apply: false });
    c = {
      dryRun: false,
      quarantined: 0,
      quarantines: [],
      removed: 0,
      branchesRemoved: 0,
      skipped: [],
      failures: [],
      failed: [],
      failedCount: 0,
      actions: [],
      unknown: preview.unknown,
      existingQuarantines: preview.existingQuarantines,
      note: 'TEST MUTATION: clean --apply returned without moving any planned worktree',
    };
  } else {
    c = await clean(root, { apply: true });
  }
  console.log(`  clean --apply: quarantined ${c.quarantined}, skipped ${c.skipped.length}, failed ${c.failures.length}`
    + (MUTATE_NOOP_CLEAN ? '  [NO-OP RED CONTROL]' : ''));

  if (c.dryRun !== false) errors.push('clean --apply reported dryRun=true');
  if (c.removed !== 0 || c.branchesRemoved !== 0) {
    errors.push(`clean physically removed ${c.removed} worktree(s) / ${c.branchesRemoved} branch(es)`);
  }
  if (c.failedCount !== 0 || c.failures.length !== 0) {
    errors.push(`clean reported ${c.failedCount} unexpected failure(s): ${JSON.stringify(c.failures)}`);
  }
  if (c.skipped.length !== 0) {
    errors.push(`clean reported ${c.skipped.length} unexpected skip(s): ${JSON.stringify(c.skipped)}`);
  }
  const cleanUnknown = c.unknown.map((entry) => entry.id).sort();
  if (JSON.stringify(cleanUnknown) !== JSON.stringify(expectedUnknown)) {
    errors.push(`clean unknown set ${JSON.stringify(cleanUnknown)} != planted ${JSON.stringify(expectedUnknown)}`);
  }
  const actionPathCounts = new Map();
  for (const action of c.actions) {
    const resolved = path.resolve(action.path);
    actionPathCounts.set(resolved, (actionPathCounts.get(resolved) ?? 0) + 1);
  }
  for (const [actionPath, count] of actionPathCounts) {
    if (count !== 1) errors.push(`clean emitted ${count} lifecycle actions for ${actionPath}`);
  }

  const expectedQuarantine = lifecycleRecords.filter(
    (record) => record.expectedDisposition === 'quarantine',
  );
  const quarantinedActions = c.actions.filter((action) => action.action === 'quarantined');
  if (c.quarantined !== quarantinedActions.length || c.quarantines.length !== quarantinedActions.length) {
    errors.push('clean quarantine counts disagree across count, actions, and quarantine records');
  }
  if (quarantinedActions.length !== expectedQuarantine.length) {
    errors.push(`clean quarantined ${quarantinedActions.length}/${expectedQuarantine.length} expected worktrees`);
  }

  const recoveryInventory = await quarantines(root);
  if (recoveryInventory.transitions.length !== 0) {
    errors.push(`clean left ${recoveryInventory.transitions.length} interrupted quarantine transition(s)`);
  }
  if (recoveryInventory.count !== quarantinedActions.length) {
    errors.push(`quarantine inventory has ${recoveryInventory.count}, clean actions have ${quarantinedActions.length}`);
  }
  const registryAfterClean = await registeredWorktrees(root);

  for (const record of lifecycleRecords) {
    const action = await findByPath(c.actions, record.originalPath) ?? null;
    record.cleanAction = action;
    const expectsQuarantine = record.expectedDisposition === 'quarantine';
    if (expectsQuarantine && action?.action !== 'quarantined') {
      errors.push(`${record.id}: expected one real quarantine action, got ${action?.action ?? 'none'}`);
    }
    if (!expectsQuarantine && action) {
      errors.push(`${record.id}: retained planted state unexpectedly received clean action ${action.action}`);
    }

    const actualPath = action?.action === 'quarantined' ? action.quarantinePath : record.originalPath;
    record.afterCleanPath = actualPath;
    const after = await worktreeIdentity(actualPath);
    const registration = await registeredAt(registryAfterClean, actualPath);
    record.afterClean = { identity: after, registration };

    if (record.before.present) {
      record.exactAfterClean = sameWorktreeIdentity(record.before, after);
      if (!record.exactAfterClean) {
        errors.push(`${record.id}: exact working/Git state changed during clean (${identityMismatch(record.before, after)})`);
      }
    } else {
      record.exactAfterClean = after.present === false
        && registration?.head === record.registrationBefore.head
        && registration?.branch === record.registrationBefore.branch;
      if (!record.exactAfterClean) errors.push(`${record.id}: broken registration changed during clean`);
    }

    if (record.atomicFile && after.present) {
      const actualAtomic = await exactFileIdentity(path.join(actualPath, record.atomicFile.relativePath))
        .catch(() => null);
      const exactAtomic = actualAtomic?.sha256 === record.atomicFile.sha256
        && actualAtomic?.bytes === record.atomicFile.bytes
        && actualAtomic?.mode === record.atomicFile.mode;
      record.afterClean.atomicFile = actualAtomic;
      if (!exactAtomic) errors.push(`${record.id}: atomic safety file changed byte/mode identity`);
    }

    if (action?.action === 'quarantined') {
      const originalPresent = await pathPresent(record.originalPath);
      const originalRegistered = await registeredAt(registryAfterClean, record.originalPath);
      const inventory = await findByPath(
        recoveryInventory.quarantines,
        record.originalPath,
        'originalPath',
      ) ?? null;
      const expectedMove = ['git', 'worktree', 'move', '-f', '-f', action.quarantinePath, record.originalPath];
      const expectedUnlock = ['git', 'worktree', 'unlock', record.originalPath];
      const shortBranch = record.before.branch?.replace(/^refs\/heads\//, '') ?? null;
      if (originalPresent || originalRegistered) errors.push(`${record.id}: original remained active after quarantine`);
      if (await samePathAsync(action.quarantinePath, record.originalPath)) {
        errors.push(`${record.id}: quarantine path is not distinct from the original`);
      }
      if (!registration?.locked || !registration.lockReason?.startsWith('holt: clean quarantine')) {
        errors.push(`${record.id}: quarantine is not registered with its exact Holt transit lock`);
      }
      if (registration?.head !== record.before.head || registration?.branch !== record.before.branch) {
        errors.push(`${record.id}: quarantine registration changed HEAD/branch`);
      }
      if (action.head !== record.before.head || action.branch !== shortBranch) {
        errors.push(`${record.id}: clean action recorded the wrong HEAD/branch`);
      }
      if (!Array.isArray(action.restoreArgv)
          || JSON.stringify(action.restoreArgv[0]) !== JSON.stringify(expectedMove)
          || JSON.stringify(action.restoreArgv[1]) !== JSON.stringify(expectedUnlock)) {
        errors.push(`${record.id}: restore argv is not the exact move-then-unlock recipe`);
      }
      if (!inventory || inventory.quarantinePath !== action.quarantinePath
          || inventory.head !== record.before.head || inventory.branch !== shortBranch
          || inventory.locked !== true) {
        errors.push(`${record.id}: recovery inventory does not exactly match the clean action`);
      }
    } else if (record.before.present && !registration) {
      errors.push(`${record.id}: retained worktree lost its Git registration`);
    }
  }

  // Duplicate work is an atomic safety unit, but quarantine promises more than "at least one":
  // because it does not delete, both planted working copies must remain byte/state-exact here.
  for (const [a, b] of truth.eitherNotBoth) {
    if (!lifecycleById.get(a)?.exactAfterClean || !lifecycleById.get(b)?.exactAfterClean) {
      errors.push(`${a}+${b}: duplicate-pair durability was not byte/state exact after clean`);
    }
  }

  // Parse each foreign lock record independently. One unrelated `locked` line cannot satisfy the
  // whole denominator, and the human's exact reason is part of the authority state.
  for (const id of truth.foreignLocked) {
    const record = lifecycleById.get(id);
    const afterRegistration = await registeredAt(registryAfterClean, record.originalPath);
    if (!afterRegistration?.locked
        || afterRegistration.lockReason !== record.registrationBefore.lockReason
        || afterRegistration.path !== record.registrationBefore.path) {
      errors.push(`${id}: exact foreign lock registration/reason changed`);
    }
  }

  /* ------------------------------------------ restore / purge lifecycle ---- */
  const lifecycleOperations = {
    restore: null,
    purge: null,
    dirtyPurgeRefusal: null,
    purgeRace: null,
    otherRestores: [],
  };

  const restoreAndVerify = async (record, expectedIdentity, operationLabel) => {
    if (record?.cleanAction?.action !== 'quarantined') {
      errors.push(`${record?.id ?? operationLabel}: cannot ${operationLabel}; no real quarantine exists`);
      return { ok: false, skipped: true, reason: 'missing quarantine action' };
    }
    const result = await restoreQuarantine(root, record.id);
    const [identity, registry, quarantinePresent] = await Promise.all([
      worktreeIdentity(record.originalPath),
      registeredWorktrees(root),
      pathPresent(record.cleanAction.quarantinePath),
    ]);
    const originalRegistration = await registeredAt(registry, record.originalPath);
    const quarantineRegistration = await registeredAt(registry, record.cleanAction.quarantinePath);
    const exact = sameWorktreeIdentity(expectedIdentity, identity);
    const authorityRestored = originalRegistration?.head === expectedIdentity.head
      && originalRegistration?.branch === expectedIdentity.branch
      && originalRegistration?.locked === record.registrationBefore.locked
      && originalRegistration?.lockReason === record.registrationBefore.lockReason;
    const complete = result.ok === true && result.restored === true
      && result.originalPath === record.originalPath
      && !quarantinePresent && !quarantineRegistration
      && exact && authorityRestored;
    if (!complete) {
      errors.push(`${record.id}: ${operationLabel} did not restore exact bytes/Git/lock authority`
        + ` (${result.error ?? identityMismatch(expectedIdentity, identity)})`);
    }
    record.terminal = {
      kind: 'restored',
      operationLabel,
      exactDurable: complete,
      result,
      identity,
      registration: originalRegistration,
      quarantinePresent,
      quarantineRegistered: Boolean(quarantineRegistration),
    };
    return record.terminal;
  };

  // A dirty quarantine must refuse before an anchor/unlock/removal is attempted. Then the ordinary
  // restore path must return the newly arrived bytes too — quarantine is a container, not a frozen
  // scan result.
  {
    const record = lifecycleById.get(truth.lifecycle.dirtyPurgeRefusal);
    if (record?.cleanAction?.action === 'quarantined') {
      const late = `DIRTY_AFTER_QUARANTINE_${sha256(record.id).slice(0, 16)}\n`;
      await write(record.cleanAction.quarantinePath, 'late/dirty-after-quarantine.txt', late);
      const mutatedIdentity = await worktreeIdentity(record.cleanAction.quarantinePath);
      const lateIdentity = await exactFileIdentity(
        path.join(record.cleanAction.quarantinePath, 'late/dirty-after-quarantine.txt'),
      );
      const refused = await purgeQuarantine(root, record.id, { apply: true });
      const registry = await registeredWorktrees(root);
      const registration = await registeredAt(registry, record.cleanAction.quarantinePath);
      const retained = await worktreeIdentity(record.cleanAction.quarantinePath);
      const correctRefusal = refused.ok === false && refused.blocked === true
        && refused.failedCount === 1 && !refused.recoveryRef
        && registration?.locked === true
        && sameWorktreeIdentity(mutatedIdentity, retained);
      if (!correctRefusal) {
        errors.push(`${record.id}: dirty purge did not refuse before removal while retaining exact bytes`);
      }
      lifecycleOperations.dirtyPurgeRefusal = {
        correct: correctRefusal,
        result: refused,
        lateIdentity,
        retainedIdentity: retained,
      };
      const restored = await restoreAndVerify(record, mutatedIdentity, 'dirty-purge refusal restore');
      lifecycleOperations.dirtyPurgeRefusal.restored = restored;
    } else {
      errors.push(`${record?.id ?? truth.lifecycle.dirtyPurgeRefusal}: dirty-purge control was not quarantined`);
      lifecycleOperations.dirtyPurgeRefusal = { correct: false, skipped: true };
    }
  }

  // Plant a writer in purge's explicit seam after identity/cleanliness checks and exact-HEAD
  // anchoring, but before non-forced removal. Git must refuse, Holt must restore the exact lock,
  // the recovery ref must remain reachable, and restore must return the late bytes.
  {
    const record = lifecycleById.get(truth.lifecycle.purgeRace);
    if (record?.cleanAction?.action === 'quarantined') {
      const late = `PURGE_RACE_${sha256(record.id).slice(0, 16)}\n`;
      let seamRan = false;
      const refused = await purgeQuarantine(root, record.id, {
        apply: true,
        onBeforeRemove: async ({ quarantinePath }) => {
          seamRan = true;
          await write(quarantinePath, 'late/purge-race.txt', late);
        },
      });
      const registry = await registeredWorktrees(root);
      const registration = await registeredAt(registry, record.cleanAction.quarantinePath);
      const retained = await worktreeIdentity(record.cleanAction.quarantinePath);
      const lateIdentity = await exactFileIdentity(path.join(record.cleanAction.quarantinePath, 'late/purge-race.txt'))
        .catch(() => null);
      const anchored = refused.recoveryRef
        ? await sh('git', ['rev-parse', '--verify', `${refused.recoveryRef}^{commit}`], root)
        : { code: 1, stdout: '' };
      const correctRefusal = seamRan && refused.ok === false && refused.failedCount === 1
        && refused.relocked === true
        && registration?.locked === true
        && registration.lockReason === record.afterClean.registration.lockReason
        && lateIdentity?.sha256 === sha256(late)
        && anchored.code === 0 && anchored.stdout.trim() === record.before.head;
      if (!correctRefusal) {
        errors.push(`${record.id}: purge race failed to retain/relock late bytes with reachable exact-HEAD ref`);
      }
      lifecycleOperations.purgeRace = {
        correct: correctRefusal,
        seamRan,
        result: refused,
        lateIdentity,
        retainedIdentity: retained,
        anchoredHead: anchored.stdout.trim() || null,
      };
      const restored = await restoreAndVerify(record, retained, 'purge-race restore');
      lifecycleOperations.purgeRace.restored = restored;
    } else {
      errors.push(`${record?.id ?? truth.lifecycle.purgeRace}: purge-race control was not quarantined`);
      lifecycleOperations.purgeRace = { correct: false, skipped: true };
    }
  }

  // Positive purge remains separately named and dry-run first. It may remove only the clean
  // quarantine checkout, never its branch; the exact HEAD must be anchored before reclamation.
  {
    const record = lifecycleById.get(truth.lifecycle.purge);
    if (record?.cleanAction?.action === 'quarantined') {
      const preview = await purgeQuarantine(root, record.id);
      const applied = await purgeQuarantine(root, record.id, { apply: true });
      const registry = await registeredWorktrees(root);
      const originalPresent = await pathPresent(record.originalPath);
      const quarantinePresent = await pathPresent(record.cleanAction.quarantinePath);
      const anchored = applied.recoveryRef
        ? await sh('git', ['rev-parse', '--verify', `${applied.recoveryRef}^{commit}`], root)
        : { code: 1, stdout: '' };
      const branch = record.before.branch
        ? await sh('git', ['rev-parse', '--verify', `${record.before.branch}^{commit}`], root)
        : { code: 0, stdout: `${record.before.head}\n` };
      const originalRegistration = await registeredAt(registry, record.originalPath);
      const quarantineRegistration = await registeredAt(registry, record.cleanAction.quarantinePath);
      const complete = preview.ok === true && preview.dryRun === true && preview.removed === 0
        && preview.wouldRemove?.length === 1
        && preview.wouldRemove[0].path === record.cleanAction.quarantinePath
        && applied.ok === true && applied.purged === true && applied.removed === 1
        && applied.branchesRemoved === 0
        && !originalPresent && !quarantinePresent
        && !originalRegistration
        && !quarantineRegistration
        && anchored.code === 0 && anchored.stdout.trim() === record.before.head
        && branch.code === 0 && branch.stdout.trim() === record.before.head;
      if (!complete) errors.push(`${record.id}: clean purge did not preserve exact HEAD/branch recovery authority`);
      record.terminal = {
        kind: 'purged',
        exactDurable: complete,
        preview,
        result: applied,
        originalPresent,
        quarantinePresent,
        originalRegistered: Boolean(originalRegistration),
        quarantineRegistered: Boolean(quarantineRegistration),
        anchoredHead: anchored.stdout.trim() || null,
        branchHead: branch.stdout.trim() || null,
      };
      lifecycleOperations.purge = record.terminal;
    } else {
      errors.push(`${record?.id ?? truth.lifecycle.purge}: positive purge control was not quarantined`);
      lifecycleOperations.purge = { kind: 'purged', exactDurable: false, skipped: true };
    }
  }

  // Restore the named untouched control, then every other ordinary quarantine. The two hostile
  // purge controls were already restored from their post-race identities above; the positive
  // purge deliberately has no checkout left.
  {
    const record = lifecycleById.get(truth.lifecycle.restore);
    lifecycleOperations.restore = await restoreAndVerify(record, record?.before, 'named restore');
  }
  const alreadyTerminal = new Set([
    truth.lifecycle.restore,
    truth.lifecycle.purge,
    truth.lifecycle.dirtyPurgeRefusal,
    truth.lifecycle.purgeRace,
  ]);
  for (const record of lifecycleRecords) {
    if (alreadyTerminal.has(record.id) || record.cleanAction?.action !== 'quarantined') continue;
    lifecycleOperations.otherRestores.push(
      await restoreAndVerify(record, record.before, 'full-denominator restore'),
    );
  }

  const finalInventory = await quarantines(root);
  if (finalInventory.count !== 0 || finalInventory.transitions.length !== 0) {
    errors.push(`lifecycle left ${finalInventory.count} quarantine(s) and ${finalInventory.transitions.length} transition(s)`);
  }
  const finalRegistry = await registeredWorktrees(root);
  for (const record of lifecycleRecords) {
    if (record.terminal) continue;
    const identity = await worktreeIdentity(record.originalPath);
    const registration = await registeredAt(finalRegistry, record.originalPath);
    const exact = record.before.present
      ? sameWorktreeIdentity(record.before, identity)
      : identity.present === false
        && registration?.head === record.registrationBefore.head
        && registration?.branch === record.registrationBefore.branch;
    record.terminal = {
      kind: record.before.present ? 'active-retained' : 'broken-registration-retained',
      exactDurable: exact,
      identity,
      registration,
    };
    if (!exact) errors.push(`${record.id}: terminal retained identity no longer matches planted state`);
  }

  const lifecycleSummary = {
    planted: lifecycleRecords.length,
    expectedQuarantine: expectedQuarantine.length,
    quarantined: quarantinedActions.length,
    restored: lifecycleRecords.filter((record) => record.terminal?.kind === 'restored').length,
    purged: lifecycleRecords.filter((record) => record.terminal?.kind === 'purged'
      && record.terminal.exactDurable).length,
    exactAfterClean: lifecycleRecords.filter((record) => record.exactAfterClean).length,
    exactTerminal: lifecycleRecords.filter((record) => record.terminal?.exactDurable).length,
    cleanFailures: c.failedCount,
    cleanSkips: c.skipped.length,
    remainingQuarantines: finalInventory.count,
    remainingTransitions: finalInventory.transitions.length,
    noOpRedControl: MUTATE_NOOP_CLEAN,
  };

  // Rescue a sample of the survivors end-to-end and verify by bytes from the REF.
  let rescued = 0;
  const rescueEvidence = [];
  for (const [id, spec] of [...truth.mustSurvive].slice(0, 5)) {
    if (!spec || !spec[0]) continue;
    const planted = lifecycleById.get(id)?.atomicFile;
    const r = await rescue(root, id, { release: true });
    if (!r.ok) {
      const error = `${id}: rescue failed: ${r.error}`;
      errors.push(error);
      rescueEvidence.push({ id, ok: false, error: r.error ?? null });
      continue;
    }
    const show = await sh('git', ['show', `${r.commit}:${spec[0]}`], root);
    const treeEntry = await sh('git', ['ls-tree', r.commit, '--', spec[0]], root);
    const rescuedBytes = Buffer.from(show.stdout);
    const rescuedMode = treeEntry.stdout.match(/^(\d+)\s/)?.[1] ?? null;
    const expectedMode = planted && (planted.mode & 0o111) ? '100755' : '100644';
    const bytesVerified = show.code === 0 && planted
      && rescuedBytes.length === planted.bytes
      && sha256(rescuedBytes) === planted.sha256
      && rescuedMode === expectedMode;
    if (!bytesVerified) errors.push(`${id}: rescued ref does not contain the exact planted file bytes/mode`);
    else rescued++;
    rescueEvidence.push({
      id,
      ok: r.ok,
      commit: r.commit ?? null,
      path: spec[0],
      expected: planted,
      gitShowExitCode: show.code,
      rescued: {
        bytes: rescuedBytes.length,
        sha256: sha256(rescuedBytes),
        gitMode: rescuedMode,
      },
      bytesVerified,
    });
  }

  // Rescue is part of the destructive loop, so "terminal" means after rescue too. Re-read every
  // planted active path and every purge ref instead of assuming a successful intermediate check
  // stayed true. Lock authority is recorded separately because `rescue --release` intentionally
  // releases Holt's risk lock; user bytes, HEAD, branch, index, and status must remain exact.
  const registryAfterAllActions = await registeredWorktrees(root);
  for (const record of lifecycleRecords) {
    if (record.terminal?.kind === 'purged') {
      const recoveryRef = record.terminal.result?.recoveryRef;
      const anchored = recoveryRef
        ? await sh('git', ['rev-parse', '--verify', `${recoveryRef}^{commit}`], root)
        : { code: 1, stdout: '' };
      const branch = record.before.branch
        ? await sh('git', ['rev-parse', '--verify', `${record.before.branch}^{commit}`], root)
        : { code: 0, stdout: `${record.before.head}\n` };
      const originalRegistration = await registeredAt(registryAfterAllActions, record.originalPath);
      const quarantineRegistration = await registeredAt(
        registryAfterAllActions,
        record.cleanAction.quarantinePath,
      );
      const exact = anchored.code === 0 && anchored.stdout.trim() === record.before.head
        && branch.code === 0 && branch.stdout.trim() === record.before.head
        && !originalRegistration
        && !quarantineRegistration;
      record.afterAllActions = {
        kind: 'purge-ref',
        exactDurable: exact,
        recoveryRef,
        anchoredHead: anchored.stdout.trim() || null,
        branchHead: branch.stdout.trim() || null,
      };
      if (!exact) errors.push(`${record.id}: purge recovery authority changed after later lifecycle actions`);
      continue;
    }
    const identity = await worktreeIdentity(record.originalPath);
    const registration = await registeredAt(registryAfterAllActions, record.originalPath);
    const expectedIdentity = record.terminal?.identity ?? record.before;
    const exact = expectedIdentity.present
      ? sameWorktreeIdentity(expectedIdentity, identity)
      : identity.present === false
        && registration?.head === record.registrationBefore.head
        && registration?.branch === record.registrationBefore.branch;
    record.afterAllActions = { kind: 'worktree', exactDurable: exact, identity, registration };
    if (!exact) errors.push(`${record.id}: final identity changed after restore/purge/rescue`);
  }
  lifecycleSummary.exactTerminal = lifecycleRecords.filter(
    (record) => record.afterAllActions?.exactDurable,
  ).length;
  console.log(`  lifecycle: ${lifecycleSummary.quarantined}/${lifecycleSummary.expectedQuarantine} quarantined, `
    + `${lifecycleSummary.restored} restored, ${lifecycleSummary.purged} purged, `
    + `${lifecycleSummary.exactTerminal}/${lifecycleSummary.planted} exact terminal identities`);
  const destructiveLoopMs = Date.now() - destructiveStarted;
  console.log(`  rescue sample: ${rescued} verified by bytes from refs`);

  let scratchCleanup;
  try {
    scratchCleanup = await cleanWorkRoot();
  } catch (error) {
    scratchCleanup = {
      requested: !KEEP,
      removed: false,
      retained: true,
      error: error.message,
    };
    errors.push(`scratch cleanup failed closed: ${error.message}`);
  }

  const sourceAfter = await sourceIdentity();
  const sourceStable = sourceBefore.head === sourceAfter.head
    && sourceBefore.dirtyStateSha256 === sourceAfter.dirtyStateSha256
    && sourceBefore.runtimeAndEvaluatorSha256 === sourceAfter.runtimeAndEvaluatorSha256;

  const [gitVersion, ctagsVersion] = await Promise.all([
    sh('git', ['--version'], SOURCE_ROOT),
    sh('ctags', ['--version'], SOURCE_ROOT),
  ]);
  const finishedAt = new Date().toISOString();
  const rawEvidence = {
    kind: 'holt-monster-evaluation',
    schemaVersion: 2,
    generatedAt: finishedAt,
    protocol: {
      startedAt,
      finishedAt,
      requestedWorktrees: COUNT,
      minimumWorktrees: 20,
      sourceBound: true,
      installedArtifactBound: false,
      stages: [
        'discover', 'scan', 'analyze', 'protect', 'clean --apply',
        'quarantine identity', 'restore', 'purge preview/apply', 'dirty purge refusal',
        'purge late-writer race', 'rescue --release',
      ],
      noOpCleanMutationControl: MUTATE_NOOP_CLEAN,
      workRoot: WORK,
      workRetained: scratchCleanup.retained,
      scratchCleanup,
      evidenceWriteOnce: OUT !== null,
      artifactPath: OUT,
    },
    source: {
      before: sourceBefore,
      after: sourceAfter,
      stable: sourceStable,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      git: { available: gitVersion.code === 0, output: gitVersion.stdout.trim() || gitVersion.stderr.trim() },
      ctags: {
        available: ctagsVersion.code === 0 && langProbe.available,
        output: ctagsVersion.stdout.trim() || ctagsVersion.stderr.trim(),
        advertisedLanguageCount: langProbe.count,
        degradedProbe: langProbe.degraded === true,
        demonstratedCoverage: cov,
      },
    },
    fixture: {
      builtWorktrees: total,
      planted: {
        mustSurvive: [...truth.mustSurvive].map(([id, [relativePath, marker]]) => ({ id, relativePath, marker })),
        disposable: [...truth.disposable],
        generatedLookingUnverified: [...truth.generatedOnly],
        duplicatePairs: truth.eitherNotBoth.map(([a, b, marker]) => ({ a, b, marker })),
        unknownExpected: [...truth.unknownExpected],
        foreignLocked: [...truth.foreignLocked],
        gitignoredOnly: [...truth.gitignoredOnly],
        lifecycleControls: truth.lifecycle,
        gold50: [...truth.gold50].map(([id, symbol]) => ({
          id, symbol,
          corpusIndex: truth.gold50Corpus.get(id)?.corpusIndex ?? null,
          file: truth.gold50Corpus.get(id)?.file ?? null,
          language: truth.gold50Lang.get(id) ?? null,
        })),
      },
      denominators: {
        reportWorkstreams: report.counts.workstreams,
        mustSurvive: truth.mustSurvive.size,
        disposable: truth.disposable.size,
        generatedLookingUnverified: truth.generatedOnly.size,
        duplicatePairs: truth.eitherNotBoth.length,
        unknownExpected: truth.unknownExpected.size,
        foreignLocked: truth.foreignLocked.size,
        gitignoredOnly: truth.gitignoredOnly.size,
        gold50Planted: truth.gold50.size,
        gold50CorpusSize: GOLD50.length,
        gold50UniqueSnippets: new Set(
          [...truth.gold50Corpus.values()].map((entry) => entry.corpusIndex),
        ).size,
        gold50Supported: truth.gold50.size - goldUnsupported,
        plantedLifecycleRecords: lifecycleRecords.length,
        expectedQuarantines: expectedQuarantine.length,
      },
    },
    oracle: {
      independentOfVerdictImplementation: true,
      method: 'planted full filesystem manifests plus raw HEAD, branch, index, status, registration, lock, quarantine, restore, purge, and exact rescue-ref identities',
      reportCounts: report.counts,
      diagnosticErrors,
      diagnosticCorrect: diagnosticErrors.length === 0,
      gold50Detected: goldSeen,
      gold50Unsupported: goldUnsupported,
      protect: p,
      cleanApply: c,
      lifecycle: {
        summary: lifecycleSummary,
        operations: lifecycleOperations,
        records: lifecycleRecords,
        finalInventory,
      },
      rescueSample: rescueEvidence,
      rescueVerified: rescued,
      rescueRequested: rescueEvidence.length,
      lifecyclePlanted: lifecycleSummary.planted,
      lifecycleExpectedQuarantine: lifecycleSummary.expectedQuarantine,
      lifecycleQuarantined: lifecycleSummary.quarantined,
      lifecycleRestored: lifecycleSummary.restored,
      lifecyclePurged: lifecycleSummary.purged,
      lifecycleExactTerminal: lifecycleSummary.exactTerminal,
      finalErrors: errors,
    },
    timing: {
      scanAnalyzeMs,
      destructiveLoopMs,
    },
    outcome: {
      correct: errors.length === 0,
      valid: errors.length === 0 && sourceStable,
      publicationEligible: false,
      refusalReasons: [
        ...(errors.length ? [`${errors.length} oracle or lifecycle failure(s)`] : []),
        ...(!sourceStable ? ['source or evaluator changed during the run'] : []),
        ...(sourceBefore.dirty ? ['source checkout was dirty at run start'] : []),
        ...(!OUT ? ['no write-once --out artifact was requested'] : []),
        'source-bound harness does not prove the frozen installed package',
      ],
    },
  };

  if (OUT) {
    const written = await writeEvidenceArtifact(OUT, rawEvidence, [{
      correct: rawEvidence.outcome.correct,
      valid: rawEvidence.outcome.valid,
      publicationEligible: rawEvidence.outcome.publicationEligible,
      builtWorktrees: total,
      reportWorkstreams: report.counts.workstreams,
      gold50Detected: goldSeen,
      gold50UniqueSnippets: rawEvidence.fixture.denominators.gold50UniqueSnippets,
      gold50Supported: truth.gold50.size - goldUnsupported,
      rescueVerified: rescued,
      rescueRequested: rescueEvidence.length,
      scanAnalyzeMs,
      destructiveLoopMs,
    }]);
    console.log(`  evidence: ${OUT} (${written.identity}, file ${written.fileSha256})`);
  }

  if (errors.length) {
    console.error(`\n  ✗ ${errors.length} FAILURES:\n${errors.slice(0, 20).map((e) => `    ${e}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('\n  ✓ MONSTER SURVIVED: every verdict correct, every irreplaceable byte intact\n');
  }

}

main().catch((e) => { console.error(e); process.exit(1); });
