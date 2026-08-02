// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the NATIVE PATH class, proven closed rather than declared closed.
 *
 * scripts/lint-native-paths.mjs is the gate. This file is the evidence that the gate works, and it
 * is deliberately three separate proofs, because any one of them alone is worthless:
 *
 *   1. IT IS GREEN ON THE REAL TREE. A lint that fires on correct code is uninstalled within a
 *      week, and an uninstalled lint proves nothing forever after.
 *   2. IT GOES RED ON EACH OF THE FOUR HISTORICAL DEFECTS. Not on invented look-alikes — on the
 *      actual source that shipped, copied out of the commits that fixed it. A check nobody has
 *      watched fire is a check nobody can trust to have found nothing.
 *   3. IT IS GREEN ON THE FIXED SPELLING OF EACH ONE, and on every legitimate forward-slash
 *      idiom the codebase already uses. Red-on-broken without green-on-fixed only proves the
 *      rule is loud.
 *
 * And the fourth, which is the failure mode this whole repository is organised against: the
 * clean-tree assertion asserts the FILE COUNT too. "No findings" and "read no files" produce the
 * same output, and only one of them is a result.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileFindings, lintTree, format } from '../../scripts/lint-native-paths.mjs';
import { scanSource, sourceFiles } from '../../scripts/lib/source-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* ============================================================ 1. green on the real tree ==== */

test('NATIVE PATHS: the tree is clean — and the check actually read it', async () => {
  const stats = { files: 0 };
  const findings = await lintTree(ROOT, { stats });

  // ANTI-VACUITY FIRST, because it is the assertion that makes the next one mean anything. A
  // mistyped root, a checkout that landed elsewhere, a readdir that threw — every one of those
  // yields zero findings, and zero findings is what "pass" looks like.
  assert.ok(stats.files > 100,
    `the lint must have read the real source tree; it opened only ${stats.files} file(s)`);

  assert.deepEqual(findings.map(format), [],
    'a native path is being used as text somewhere. Four Windows-only defects in this project came '
    + 'from exactly this: a guard that allowed destructive commands, a fixture that died before it '
    + 'tested anything, and two silent under-refusals — all green on Linux.');
});

/* ================================================= 2. RED on the four historical defects ==== */

/**
 * Each fixture is the SHIPPED source of a real defect, reduced to the statements that carry it.
 * The header of each says which commit fixed it, so a reader can diff the claim against history.
 */
const DEFECTS = [
  {
    name: 'DEFECT 1a — the glob pattern built in \'/\' space (fixed in 21e803b3)',
    rule: 'native-path-pattern',
    programs: false,
    // targetWorkstreams(), verbatim in shape: the pattern is joined with '/', the subject is a
    // canonical path, and on Windows the two are in different alphabets. Every CONTAINMENT and
    // LOOP glob test returned ALLOW on windows-latest.
    src: `
async function targetWorkstreams(report, target, cwd) {
  const base = cwd || process.cwd();
  const abs = await canonicalPath(path.resolve(base, globFreePrefix(target)));
  const suffix = 'wt-*';
  const re = suffix ? pathMatcher(\`\${abs}/\${suffix}\`.replace(/\\/+/g, '/')).re : null;
  const out = [];
  for (const s of report.safe) {
    const sp = await canonicalPath(s.path);
    for (let p = sp; p.length >= abs.length; p = path.dirname(p)) {
      if (re.test(p)) { out.push(s); break; }
      if (path.dirname(p) === p) break;
    }
  }
  return out;
}
`,
  },
  {
    name: 'DEFECT 1b — a native path split on \'/\'',
    rule: 'native-path-split',
    programs: false,
    // The same rule from the other side: pathMatcher splits on '/', so a native path handed to
    // '/'-space machinery has one segment on Windows and the glob selects nothing.
    src: `
function globFreePrefixOf(base, target) {
  const abs = path.resolve(base, target);
  const parts = abs.split('/');
  return parts.slice(0, 2).join('/');
}
`,
  },
  {
    name: 'DEFECT 2/3 — a native path pasted raw into a generated program (fixed in 7dccc58c)',
    rule: 'native-path-in-source',
    programs: true,
    // `q` QUOTES; it does not ESCAPE. C:\\Users\\x inside those quotes makes \\U and \\x escape
    // sequences, so the program under test was corrupted before it was parsed — and a Windows path
    // spelled CORRECTLY in source carries doubled backslashes that are not in the real path, so
    // the extractor resolved it to nothing and the removal was ALLOWED.
    src: `
const q = (s) => \`'\${s}'\`;
const RM_ = 'rm';
const body = \`execFile(\${q(RM_)},[\${q('-rf')},\${q(fx.wt('uniqueUncommitted'))}])\`;
const read = \`require(\${q('child_process')}).execSync(\${q('git status')},{cwd:\${q(fx.root)}})\`;
`,
  },
  {
    name: 'DEFECT 4 — os.devNull handed to git (fixed in 49d0b46b)',
    rule: 'devnull-to-git',
    programs: false,
    // `fatal: unable to access '//./nul': Invalid argument`. The fixture died in SETUP on Windows,
    // so everything it contained reported nothing while appearing to have run.
    src: `
function realGit(args, cwd) {
  return execFile('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull },
  });
}
`,
  },
  {
    name: 'DEFECT 5 — a cross-source path comparison (found by this lint, in src/team/fleet.mjs)',
    rule: 'native-path-compare',
    programs: false,
    // `id` is git's --git-common-dir; `p` is the walker's own path.resolve. macOS answers
    // /private/var where the walker holds /var; Windows folds case and hands out 8.3 short names.
    // The comparison was FALSE for every candidate there, so `holt fleet` could report a linked
    // agent worktree as the repository's row.
    src: `
const rank = (p, id) => [id && path.dirname(id) === p ? 0 : 1, p.length, p];
`,
  },
  {
    name: 'DEFECT 5b — the SAME comparison written the ordinary way, through a variable',
    rule: 'native-path-compare',
    programs: false,
    // THE SHAPE, NOT THE SPELLING. An earlier draft only saw a producer sitting immediately beside
    // the operator — which is how the historical defects happened to be written — and this planted
    // violation left the gate GREEN. A lint that catches one bad call and not the shape is
    // worthless, so the same rule now follows the value into a variable.
    src: `
const home = path.join(process.cwd(), 'a');
const same = home === process.env.HOME;
`,
  },
  {
    name: 'DEFECT 6 — the main-module check (found by this lint, in scripts/check-release-body.mjs)',
    rule: 'native-path-compare',
    programs: false,
    // The same class in the one place where it makes a GATE report success having run nothing.
    // scripts/generate-hosts.mjs already carries the write-up of why this never matched on Windows.
    src: `
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
`,
  },
];

test('NATIVE PATHS: the lint FIRES on every historical defect — proven, not assumed', () => {
  for (const d of DEFECTS) {
    const found = fileFindings('planted.mjs', d.src, { programs: d.programs });
    assert.ok(found.some((f) => f.rule === d.rule),
      `${d.name}: the lint did NOT fire (${d.rule}). It cannot be trusted to have found nothing in `
      + `src/. Got: ${JSON.stringify(found.map(format))}`);
  }
});

test('NATIVE PATHS: every finding names a line and a fix, not just a rule', () => {
  // A guard nobody can follow to the defect gets ignored, and this repo has already paid for that
  // once — a line-collapsing stripper made every reported line number fiction.
  for (const d of DEFECTS) {
    const lines = d.src.split('\n');
    for (const f of fileFindings('planted.mjs', d.src, { programs: d.programs })) {
      assert.ok(f.line >= 1 && f.line <= lines.length,
        `${d.name}: reported line ${f.line} does not exist in a ${lines.length}-line fixture`);
      assert.ok(f.fix.length > 30, `${d.name}: "${f.fix}" does not tell anyone what to do instead`);
    }
  }
});

/* ================================================ 3. GREEN on the fix, and on correct code ==== */

/**
 * The other half, and the half that decides whether this gate survives contact with a real branch.
 * Each of these is code that IS in the tree (or is the committed fix for one of the defects above)
 * and must not be flagged.
 */
const NEVER_WORSE = [
  {
    name: 'the committed fix for DEFECT 1: matched in forward-slash space',
    programs: false,
    src: `
async function targetWorkstreams(report, target, cwd) {
  const base = cwd || process.cwd();
  const abs = await canonicalPath(path.resolve(base, globFreePrefix(target)));
  const suffix = 'wt-*';
  const fwd = (p) => p.replace(/\\\\/g, '/');
  const absF = fwd(abs);
  const re = suffix ? pathMatcher(\`\${absF}/\${suffix}\`.replace(/\\/+/g, '/')).re : null;
  const out = [];
  for (const s of report.safe) {
    const sp = await canonicalPath(s.path);
    for (let p = fwd(sp); re && p.length >= absF.length; p = p.replace(/\\/[^/]*$/, '')) {
      if (re.test(p)) { out.push(s); break; }
      if (!p.includes('/')) break;
    }
  }
  return out;
}
`,
  },
  {
    name: 'the committed fix for DEFECT 2/3: JSON.stringify across the source boundary',
    programs: true,
    src: `
const q = (s) => \`'\${s}'\`;
const jsStr = (v) => JSON.stringify(String(v));
const body = \`execFile(\${q('rm')},[\${q('-rf')},\${jsStr(fx.wt('uniqueUncommitted'))}])\`;
const read = \`require(\${q('child_process')}).execSync(\${q('git status')},{cwd:\${jsStr(fx.root)}})\`;
`,
  },
  {
    name: 'the committed fix for DEFECT 4: the POSIX /dev/null that MSYS git understands',
    programs: false,
    src: `
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
`,
  },
  {
    name: 'src/jj.mjs: jj is Rust, gets no MSYS translation, and NEEDS os.devNull',
    programs: false,
    // The rule keys on the TOOL. "Always use /dev/null" would be a house style that breaks this.
    src: `
function jj(args, cwd) {
  return execFile('jj', args, {
    cwd,
    env: { ...process.env, JJ_CONFIG: process.env.JJ_CONFIG ?? os.devNull, LC_ALL: 'C' },
  });
}
`,
  },
  {
    name: 'splitting a GIT-reported path on \'/\' — correct on every platform',
    programs: false,
    // git speaks forward slashes everywhere. Six places in src/ do this and all six are right.
    src: `
const rel = (await git(['ls-files'], { cwd })).stdout.trim();
const parts = rel.split('/');
const owner = String(rel).split('/').filter(Boolean)[0] ?? null;
`,
  },
  {
    name: 'the canonical helpers in src/paths.mjs, used as intended',
    programs: false,
    src: `
const same = foldCase(await canonicalPath(a)) === foldCase(await canonicalPath(b));
const rel = await relativeWithinAsync(root, abs);
const segs = rel.split('/');
const inside = await underOrEqualAsync(child, parent);
const hit = await findByPath(report.workstreams, dir);
`,
  },
  {
    name: 'path.dirname(p) === p — walking to the filesystem root',
    programs: false,
    // Both sides come from one value, so no cross-source mismatch is possible. src/jj.mjs and
    // src/paths.mjs both do this and both are right.
    src: `
let dir = abs;
for (let i = 0; i < 64; i++) {
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
`,
  },
  {
    name: 'a value compared with its OWN derivative, reached through variables',
    programs: false,
    // The origin map earns its keep here. Both sides descend from one `start`, so no cross-source
    // separator or case mismatch is possible, and reporting it would ban the ancestor walk that
    // src/jj.mjs, src/integrate/adapters.mjs and src/paths.mjs all need.
    src: `
const start = path.resolve(base, name);
let cur = start;
const up = path.dirname(cur);
if (up === cur) return null;
if (cur === start) return start;
`,
  },
  {
    name: 'endsWith(path.join(<literals>)) — the platform-correct way to spell a suffix',
    programs: false,
    // This is the CURE, not the defect: path.join over string literals is exactly how you write a
    // relative fragment that matches on both separators. Flagging it would push people back to the
    // hardcoded '/' this lint exists to remove. test/unit/host-manifest.test.mjs relies on it.
    src: `
assert.ok(user.file.endsWith(path.join('.cline', 'data', 'settings', 'cline_mcp_settings.json')));
`,
  },
  {
    name: 'this repo\'s main-module idiom',
    programs: false,
    src: `
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
`,
  },
  {
    name: 'a path mentioned in a COMMENT or a STRING is prose, not code',
    programs: true,
    // The stripper's whole job. Without it every explanatory comment in src/agent.mjs — which
    // quotes these exact shapes — would be an offence, and the lint would be unusable in the one
    // file that most needs it.
    src: `
// the old code did pathMatcher(\`\${abs}/\${suffix}\`) and then re.test(path.dirname(p))
/* it also used path.resolve(a) === b, and GIT_CONFIG_GLOBAL: os.devNull */
const doc = 'never write path.resolve(a) === b or abs.split("/")';
const help = "GIT_CONFIG_GLOBAL: os.devNull is wrong for git";
`,
  },
];

test('NATIVE PATHS: NEVER-WORSE — the fix, and every correct idiom in the tree, stay green', () => {
  for (const c of NEVER_WORSE) {
    const found = fileFindings('legit.mjs', c.src, { programs: c.programs });
    assert.deepEqual(found.map(format), [],
      `FALSE POSITIVE on ${c.name}. A gate that fails a legitimate change is as bad as one that `
      + 'never fires: it gets disabled, and then it proves nothing at all.');
  }
});

/* ========================================================== 4. the scanner's own contract ==== */

test('SCANNER: masking preserves every byte and every line of every real source file', async () => {
  // THE CONTRACT EVERY RULE ABOVE DEPENDS ON. This repo has already shipped a stripper that
  // collapsed multi-line comments and templates to one character: 7,660 of 17,651 lines of src/
  // and bin/ stopped being scanned at all while every check reported on the whole file, and every
  // reported line number was fiction. An offset-preserving transform cannot do that.
  const offenders = [];
  let checked = 0;
  for (const root of ['src', 'bin', 'scripts', 'test']) {
    for (const file of await sourceFiles(path.join(ROOT, root))) {
      const raw = await fs.readFile(file, 'utf8');
      const { code, literal } = scanSource(raw);
      checked++;
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (code.length !== raw.length) offenders.push(`${rel}: ${raw.length} bytes in, ${code.length} out`);
      if (literal.length !== raw.length) offenders.push(`${rel}: mask is ${literal.length} for ${raw.length} bytes`);
      const before = raw.split('\n').length;
      const after = code.split('\n').length;
      if (before !== after) offenders.push(`${rel}: ${before} lines in, ${after} out (${before - after} invisible)`);
    }
  }
  assert.ok(checked > 100, `ANTI-VACUITY: this must read the real source tree, only saw ${checked} files`);
  assert.deepEqual(offenders, [],
    'scanSource() changed the shape of the file, so every rule is reading a subset of the code and '
    + `reporting line numbers that do not exist:\n  ${offenders.join('\n  ')}`);
});

test('SCANNER: ANTI-VACUITY — it still marks what it must mark', () => {
  // The other direction. A scanner that marked nothing would pass the byte-for-byte contract
  // above perfectly and would then read every comment in src/agent.mjs as live code.
  const src = [
    '/* a block comment mentioning path.resolve(a) === b */',
    "const help = 'abs.split(\"/\")';",
    'const real = path.join(a, b);',
    'const tpl = `pattern ${abs}/${suffix} here`;',
  ].join('\n');
  const { code, literal } = scanSource(src);
  const at = (needle) => literal[code.indexOf(needle)];

  assert.equal(code.split('\n').length, src.split('\n').length, 'line count preserved');
  assert.ok(!code.includes('path.resolve(a) === b'), `the comment must be blanked: ${code}`);
  assert.equal(at('abs.split'), 1, 'text inside a string literal must be marked as literal');
  assert.equal(at('path.join(a, b)'), 0, 'ANTI-VACUITY: real code must NOT be marked as literal');

  // Template TEXT is literal; a `${...}` expression inside it is CODE. That distinction is the
  // entire reason this scanner exists rather than reusing no-network.test.mjs's stripper — the
  // glob defect lives in the interpolation, and a stripper that blanks it cannot see the bug.
  assert.equal(at('pattern '), 1, 'template text must be marked as literal');
  assert.equal(literal[code.indexOf('${abs}') + 2], 0, 'a template interpolation must remain CODE');
});
