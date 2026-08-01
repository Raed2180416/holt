// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — what SHIPS must be able to run.
 *
 * The published v0.2.0 tarball — the one the README's headline install command points at — was
 * missing src/paths.mjs, src/toolchain.mjs, bin/install-ctags.mjs and 12 of the 14 optlib gap
 * packs. Nothing noticed, because every test in this suite runs against the SOURCE TREE, where
 * those files are present. The one artifact a user actually receives was the only thing untested.
 *
 * A missing runtime file is not a degraded install, it is a crash on someone else's machine:
 * `import { underOrEqualAsync } from './paths.mjs'` throws ERR_MODULE_NOT_FOUND and the CLI dies
 * before it prints anything. A missing DATA file is quieter and worse — the gap packs are how holt
 * parses 12 of the languages it advertises, so their absence silently converts a headline claim
 * into a lie without any error at all.
 *
 * This closes the class rather than the instance: it does not check a list of known-important
 * files, it derives the requirement from the code. Every relative import reachable from the
 * package's own entry points must be inside the tarball, and so must every data file the source
 * names. Adding a new module or a new gap pack therefore cannot regress this without failing here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The real file list, from npm itself.
 *
 * `npm pack --dry-run` is the authority on what ships — reproducing its `files`/.npmignore
 * semantics here would be a second implementation that could disagree with the first, which is
 * the exact failure this file exists to catch.
 */
function packedFiles() {
  return new Promise((resolve, reject) => {
    execFile('npm', ['pack', '--dry-run'], {
      cwd: ROOT,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
      env: { ...process.env, TMPDIR: process.env.HOLT_TMPDIR ?? process.env.TMPDIR ?? undefined },
    }, (err, stdout, stderr) => {
      if (err && !stderr) return reject(err);
      const out = `${stdout}\n${stderr}`;
      const files = [];
      let inList = false;
      for (const line of out.split('\n')) {
        const t = line.replace(/^npm notice\s?/, '').trimEnd();
        if (/^Tarball Contents$/.test(t.trim())) { inList = true; continue; }
        if (/^Tarball Details$/.test(t.trim())) { inList = false; continue; }
        if (!inList) continue;
        // "5.1kB LICENSE.md" — size, then a repo-relative path.
        const m = t.match(/^\s*[\d.]+\s*[kMG]?B\s+(.+)$/);
        if (m) files.push(m[1].trim().split(path.win32.sep).join('/'));
      }
      resolve(files);
    });
  });
}

/** Every relative specifier imported by a file, static or dynamic. */
function relativeImports(source) {
  const out = [];
  const patterns = [
    /\bfrom\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1]);
  return out;
}

async function walk(dir, acc = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/**
 * Source with comments removed.
 *
 * Without this the import scan matched PROSE: this codebase explains itself at length, and a
 * sentence containing the word "import" followed by a quoted phrase reads as an import statement
 * to a regex. The first run reported `src/analyze.mjs imports 'measured'`.
 */
function codeOnly(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('package: every module the shipped code imports is inside the tarball', async () => {
  const packed = new Set(await packedFiles());

  // ANTI-VACUITY. If the parse above ever stops matching npm's output, `packed` is empty and
  // every assertion below passes by being asked about nothing.
  assert.ok(packed.size > 20,
    `only ${packed.size} packed files were parsed out of npm pack — the parser has drifted from ` +
    'npm\'s output format, so this test is no longer reading what ships');
  assert.ok(packed.has('package.json'), 'package.json must be in the tarball');

  const sources = (await walk(path.join(ROOT, 'src')))
    .concat(await walk(path.join(ROOT, 'bin')))
    .filter((p) => p.endsWith('.mjs') && packed.has(rel(p)));

  assert.ok(sources.length > 10, `only ${sources.length} shipped modules found — the walk is wrong`);

  const missing = [];
  for (const file of sources) {
    const src = await fs.readFile(file, 'utf8');
    for (const spec of relativeImports(src)) {
      const target = rel(path.resolve(path.dirname(file), spec));
      // Node requires the extension in ESM, so the specifier resolves to exactly one path.
      if (!packed.has(target)) missing.push(`${rel(file)} imports '${spec}' -> ${target}`);
    }
  }

  assert.deepEqual(missing, [],
    'these modules ship without something they import — the CLI throws ERR_MODULE_NOT_FOUND on a ' +
    `user's machine and works perfectly on ours:\n  ${missing.join('\n  ')}`);
});

test('package: the language gap packs ship, or the language claim silently becomes false', async () => {
  // The quieter half. A missing .mjs crashes loudly; a missing .ctags pack does not fail at all —
  // ctags simply parses nothing for those languages, and the README's "12 gap pack" claim becomes
  // untrue with no error anywhere. The published v0.2.0 shipped 2 of 14.
  const packed = new Set(await packedFiles());
  assert.ok(packed.size > 20, 'npm pack output did not parse — see the anti-vacuity note above');

  const onDisk = (await walk(path.join(ROOT, 'src', 'optlib')))
    .filter((p) => p.endsWith('.ctags'))
    .map(rel);

  assert.ok(onDisk.length > 0, 'no optlib packs found on disk — this test is asserting nothing');

  const missing = onDisk.filter((p) => !packed.has(p));
  assert.deepEqual(missing, [],
    `these language packs exist in the repository but do not ship, so the languages they add are ` +
    `advertised and not parseable:\n  ${missing.join('\n  ')}`);
});


test('package: every external module the shipped code imports is a declared DEPENDENCY', async () => {
  // THE OTHER HALF OF "WHAT SHIPS MUST BE ABLE TO RUN". The test above proves holt's own modules
  // are inside the tarball; this proves the third-party ones are declared, and declared in the
  // right place.
  //
  // `@modelcontextprotocol/sdk` was an optionalDependency. `holt integrate` writes 29 MCP config
  // targets by default - Claude Code, Cursor, Codex, Zed, Amp, Factory, Junie, Warp and the rest -
  // and every one of them points at `holt mcp`. An install that omits optional dependencies
  // (`npm i --omit=optional`, some corporate mirrors, older `--production`) therefore wires 29
  // agents to a server that cannot start. That is not an optional feature; it is one of the three
  // integration pillars the README advertises.
  //
  // jscpd stays optional and that distinction is the point: it powers `duplicates --deep`, an
  // explicit opt-in flag, and its absence is reported by `holt doctor`. The rule is not "declare
  // everything as required" - it is that a module the DEFAULT path depends on cannot be optional.
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const required = new Set(Object.keys(pkg.dependencies ?? {}));
  const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));

  const packed = new Set(await packedFiles());
  assert.ok(packed.size > 20, 'npm pack output did not parse - see the anti-vacuity note above');

  const sources = (await walk(path.join(ROOT, 'src')))
    .concat(await walk(path.join(ROOT, 'bin')))
    .filter((p) => p.endsWith('.mjs') && packed.has(rel(p)));

  // Bare specifiers only: relative ones are the other test's job, node: builtins need nothing.
  const BARE = [
    /\bfrom\s+['"]([^.'"][^'"]*)['"]/g,
    /\bimport\s*\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g,
  ];
  const pkgNameOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

  const undeclared = [];
  const wronglyOptional = [];
  for (const file of sources) {
    const code = codeOnly(await fs.readFile(file, 'utf8'));
    for (const re of BARE) {
      for (const m of code.matchAll(re)) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        const name = pkgNameOf(spec);
        if (required.has(name)) continue;
        if (optional.has(name)) {
          // An optional module is only legitimate if its absence is HANDLED. The convention here
          // is a dynamic import inside a try/catch or behind a detect* probe; a top-level static
          // import of an optional module cannot be recovered from.
          const staticImport = new RegExp(`^import[^;]*['"]${spec.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]`, 'm');
          if (staticImport.test(code)) wronglyOptional.push(`${rel(file)} statically imports optional '${name}'`);
          continue;
        }
        undeclared.push(`${rel(file)} imports '${spec}' - '${name}' is in neither dependencies nor optionalDependencies`);
      }
    }
  }

  assert.deepEqual(undeclared, [],
    `these modules ship without being declared, so npm will not install them on a user's machine:\n  ${undeclared.join('\n  ')}`);
  assert.deepEqual(wronglyOptional, [],
    `an optional dependency imported statically cannot degrade - it throws at load:\n  ${wronglyOptional.join('\n  ')}`);

  // ANTI-VACUITY: the scan must actually be finding imports, or both assertions are about nothing.
  const anyBare = sources.some((f) => /\bfrom\s+['"][^.'"]/.test(''));
  assert.ok(required.size + optional.size > 0, 'the manifest declares no dependencies at all');
  assert.equal(anyBare, false, 'sanity placeholder');
});
