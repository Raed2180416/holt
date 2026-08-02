// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the NATIVE PATH lint. One class, closed structurally, instead of four fixes.
 *
 * FOUR SEPARATE WINDOWS DEFECTS IN THIS PROJECT CAME FROM ONE MISTAKE: doing STRING work on a
 * NATIVE path. Every one of them was invisible on Linux, where the separator is '/' and the
 * filesystem is case-sensitive, so every one shipped green and was found only by the cross-OS
 * matrix — which is the expensive way to find them.
 *
 *   1. THE GLOB THAT SILENTLY ALLOWED A DESTRUCTIVE COMMAND (fixed in 21e803b3).
 *      `rootsReachedFromAbove` and `targetWorkstreams` built a glob with '/' — pathMatcher splits
 *      on '/' — and then tested the resulting regex against CANONICAL paths, which are '\\'
 *      separated on Windows. `../wt-*` therefore matched no `C:\...\wt-a` root, and EVERY
 *      containment and loop glob returned ALLOW on windows-latest. The product's core guarantee,
 *      off, on a whole platform, with a green suite. The same commit walked ancestors with
 *      `path.dirname`, whose separator is likewise platform-dependent.
 *
 *   2. A NATIVE PATH EMBEDDED RAW IN JS SOURCE. `C:\Users\x` inside a generated program makes
 *      `\U` and `\x` escape sequences, so the program under test was corrupted before it was ever
 *      parsed. JSON.stringify produces a valid literal on every platform; nothing else does.
 *
 *   3. INLINE STRINGS TAKEN AS RAW SOURCE. A Windows path written correctly in source uses
 *      DOUBLED backslashes; the extractor returned the SOURCE spelling instead of the path, so a
 *      correctly-spelled removal target resolved to nothing, holt found no target, and the
 *      removal was ALLOWED. A silent under-refusal, again only on Windows.
 *
 *   4. os.devNull HANDED TO git. git-for-windows is MSYS: it translates '/dev/null' and rejects
 *      the native `\\.\nul` outright (`fatal: unable to access '//./nul'`). A fixture died in
 *      setup on the one platform holt is least proven on — so the tests it contained reported
 *      nothing at all while appearing to have run. (jj is the opposite case and NEEDS os.devNull,
 *      because it is Rust and gets no MSYS translation. Which one is right depends on whether the
 *      tool goes through MSYS, so this lint keys on the tool, not on a house style.)
 *
 * FIXING FOUR INSTANCES IS NOT FIXING THE CLASS. The class closes when the SHAPE cannot re-enter
 * the tree, which is what this file is. Modelled on the raw-path-comparison guard in
 * test/unit/no-network.test.mjs, which closed the sibling class (comparing paths without
 * canonicalising) the same way.
 *
 * THE RULE THE FIXES ALL CONVERGED ON, and the one this enforces:
 *   do path STRING work in FORWARD-SLASH SPACE; reserve the `path` module for path OPERATIONS;
 *   never split, glob, regex or compare a NATIVE path as text.
 *
 * WHAT IT DELIBERATELY DOES NOT FLAG, because a gate that fails a legitimate change gets disabled
 * within a week and then proves nothing at all:
 *   - `rel.split('/')`, where `rel` is a git-reported path. git speaks forward slashes on every
 *     platform, so this is correct everywhere and the codebase does it in six places.
 *   - `samePathSync` / `underOrEqualSync` / `relativeWithinAsync` and the rest of src/paths.mjs —
 *     those ARE the canonical helpers this lint points people at.
 *   - a value passed through a deliberate forward-slash normaliser. `const fwd = (p) =>
 *     p.replace(/\\/g, '/')` is DETECTED as a normaliser, not pattern-matched by name, so the
 *     already-correct code in src/agent.mjs passes without an allowlist entry.
 *   - `path.dirname(p) === p`, the root-detection idiom: both sides come from one value, so no
 *     cross-source separator or case mismatch is possible.
 *
 * Run: `npm run lint:paths`
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanSource, codeMatches, lineAt, matchParen, sourceFiles } from './lib/source-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Expressions whose value is a NATIVE path — separator and case exactly as the OS spells them.
 *
 * canonicalPath() belongs here even though it is the CORRECT helper: it fixes the /var vs
 * /private/var and 8.3-short-name problems, and it still returns '\\' on Windows. Canonical is not
 * the same as forward-slash, and conflating the two is precisely how defect 1 happened.
 */
const PRODUCER_RE = /\b(?:path\s*\.\s*(?:resolve|join|dirname|normalize|toNamespacedPath)|process\s*\.\s*cwd|os\s*\.\s*(?:homedir|tmpdir)|fileURLToPath|realpath|realpathSync|canonicalPath)\s*\(/g;

/** Helpers that hand back a FORWARD-SLASH path, so their result is safe to treat as text. */
const BUILTIN_CLEARERS = [
  'relativeWithinAsync', 'relativeLinkAwareAsync', 'posixRel', 'toPosix', 'toPosixPath', 'posixify',
];

/** The two spellings of "normalise to forward slashes" this codebase actually uses inline. */
const INLINE_CLEARER_RE = /\.\s*replace\s*\(\s*\/\\\\\/g\s*,\s*['"]\/['"]\s*\)|\.\s*split\s*\(\s*path\s*\.\s*sep\s*\)\s*\.\s*join\s*\(\s*['"]\/['"]\s*\)/;

/** `const fwd = (p) => p.replace(/\\/g, '/')` — detected, so it needs no allowlist entry. */
const CLEARER_DEF_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\2\s*\.\s*replace\s*\(\s*\/\\\\\/g\s*,\s*['"]\/['"]\s*\)/g;

/** Glob/regex machinery that reasons in forward-slash space. */
const MATCHER_RE = /\b(?:pathMatcher|minimatch|micromatch|picomatch|globToRegExp)\s*\(|\bnew\s+RegExp\s*\(/g;

/** Markers that a string is an INLINE PROGRAM — source that will be parsed by an interpreter. */
const INLINE_PROGRAM_RE = /(?:^|\s)(?:-e|--eval|-c|-p)\s|require\s*\(|execSync\s*\(|execFileSync\s*\(|import\s*\(/;

/**
 * Wrappers that turn a path into a valid source literal on every platform.
 *
 * `q = (s) => \`'${s}'\`` — which test/e2e/integration.test.mjs also defines — is deliberately NOT
 * here: quoting is not escaping, and a single-quoted `C:\Users\x` still carries \U and \x.
 */
const SOURCE_SAFE_RE = /JSON\s*\.\s*stringify\s*\(|\bjsStr\s*\(/;

/**
 * An expression that is NOTHING BUT a reference to a filesystem location — `fx.root`, `dir`,
 * `fx.wt('a')` — optionally inside ONE wrapping call, which is how the historical defect was
 * actually spelled: `${q(fx.root)}`, where `q = (s) => \`'${s}'\``. Quoting a path is not
 * escaping it, and that single wrapper is the difference between the bug and its fix
 * (`${jsStr(fx.root)}`), so the rule has to see through exactly one level and no further.
 *
 * Anchored end to end on purpose: a substring match on "dir" or "file" would flag half the test
 * suite, and a rule with that hit rate is a rule someone deletes.
 */
const PATHISH_EXPR_RE = /^(?:[A-Za-z_$][\w$]*\()?\s*[\w$.]*\b(?:root|cwd|dir|path|file|wt|worktree)[\w$]*\s*(?:\([^)]*\))?\s*\)?$/i;

/** Operands that make a comparison harmless: a literal, not another path. */
const LITERAL_OPERAND_RE = /^\s*(?:['"`]|undefined\b|null\b|-?\d)/;

// ---------------------------------------------------------------------------------------------

const nameBefore = (code, i) => {
  const m = /([A-Za-z_$][\w$.]*)\s*$/.exec(code.slice(Math.max(0, i - 80), i));
  return m ? m[1] : '';
};

/** The end of the statement containing `from` — the next `;` or newline at paren/brace depth 0. */
function statementEnd(code, literal, from) {
  let paren = 0;
  let brace = 0;
  for (let i = from; i < code.length; i++) {
    if (literal[i]) continue;
    const c = code[i];
    if (c === '(' || c === '[') paren++;
    else if (c === ')' || c === ']') paren--;
    else if (c === '{') brace++;
    else if (c === '}') { if (brace === 0) return i; brace--; }
    else if ((c === ';' || c === '\n') && paren <= 0 && brace === 0) return i;
  }
  return code.length;
}

/**
 * Which local variables hold a NATIVE path, and which have been normalised out of that state.
 *
 * PROPAGATION IS BY HEAD EXPRESSION, NOT BY MENTION, and that distinction is the whole difference
 * between a usable lint and a deleted one. The first draft marked a variable native whenever a
 * native name appeared ANYWHERE in its initialiser, so `const r = await runCli(dir)` made `r`
 * a path, `r.stdout` a path, and every `assert.match(r.stdout, /…/)` in the suite an offence —
 * 50 findings, 46 of them nonsense. Taint now follows only the value: the initialiser's HEAD
 * (`path.join(…)`, or another native variable) is what decides, so passing a path INTO something
 * does not make that something a path.
 *
 * A one-file, assignment-level approximation on purpose. Its failure mode is a MISSED finding,
 * never an invented one — the correct direction for a gate that must not block a legitimate
 * change. Every rule below is additionally proven to fire on the real historical shapes by
 * test/unit/native-path-class.test.mjs, so "approximate" describes its reach, not whether it works.
 */
function taintedNames(code, literal, clearers) {
  const tainted = new Set();
  /**
   * Where each native path ULTIMATELY CAME FROM, so a value can be compared with its own
   * derivative without being reported.
   *
   * `const parent = path.dirname(dir); if (parent === dir) break;` is the walk-to-the-root idiom,
   * and it is correct: both sides are one value, so there is no cross-source separator or case
   * mismatch to have. src/jj.mjs and src/paths.mjs both write it. What is NOT correct is comparing
   * two paths that arrived from DIFFERENT places — git's spelling against the caller's — which is
   * every one of the defects src/paths.mjs was created to end. Tracking the origin is what lets
   * the rule tell those two apart instead of banning the idiom.
   */
  const origin = new Map();
  const rootOf = (n) => origin.get(n) ?? n;

  const ASSIGN_RE = /(?:(?:const|let|var)\s+|^\s*|[;{(,]\s*)([A-Za-z_$][\w$]*)\s*=(?!=)/gm;
  for (const m of codeMatches(code, literal, ASSIGN_RE)) {
    const name = m[1];
    const rhsStart = m.index + m[0].length;
    const rhs = code.slice(rhsStart, statementEnd(code, literal, rhsStart));
    if (!isNative(rhs, tainted, clearers)) { tainted.delete(name); origin.delete(name); continue; }
    tainted.add(name);
    // A BARE identifier passed straight into the producer — `path.dirname(dir)`. Anything more
    // complicated than that (`path.join(a, b)`, `canonicalPath(s.path)`) has no single origin, so
    // the variable becomes its own root and every comparison against it is reportable.
    const arg = /\(\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(rhs)?.[1];
    const head = headOf(rhs);
    if (arg && arg !== name) origin.set(name, rootOf(arg));
    else if (tainted.has(head) && head !== name) origin.set(name, rootOf(head));
    else origin.delete(name);
  }
  return { tainted, rootOf };
}

const isCleared = (expr, clearers) =>
  INLINE_CLEARER_RE.test(expr) || clearers.some((c) => new RegExp(`\\b${c}\\s*\\(`).test(expr));

/** The leading primary of an expression: `await path.join(a, b)` -> `path.join`. */
const headOf = (expr) => /^\s*(?:await\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/
  .exec(expr)?.[1]?.replace(/\s+/g, '') ?? '';

/** Does this expression EVALUATE TO a native path? */
function isNative(expr, tainted, clearers) {
  if (isCleared(expr, clearers)) return false;
  const head = headOf(expr);
  if (!head) return false;
  if (clearers.includes(head)) return false;
  if (head === '__dirname' || head === '__filename') return true;
  PRODUCER_RE.lastIndex = 0;
  const producerHead = PRODUCER_RE.exec(`${head}(`);
  if (producerHead && producerHead.index === 0) return true;
  // A member read off a native path — `abs.length` — is not itself a path; the bare name is.
  return tainted.has(head);
}

// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ file: string, line: number, rule: string, what: string, fix: string }} Finding
 */

/**
 * Every native-path-as-text offence in one file.
 * @param {string} rel  repo-relative path, for the message
 * @param {string} raw  the file's source
 * @param {{ programs?: boolean }} opts  `programs` enables the generated-source rules, which are
 *   only meaningful where source is generated (tests, fixtures, harnesses).
 * @returns {Finding[]}
 */
export function fileFindings(rel, raw, opts = {}) {
  const { code, literal, templates } = scanSource(raw);
  /** @type {Finding[]} */
  const out = [];
  const add = (index, rule, what, fix) => out.push({ file: rel, line: lineAt(code, index), rule, what, fix });

  const clearers = [...BUILTIN_CLEARERS];
  for (const m of codeMatches(code, literal, CLEARER_DEF_RE)) clearers.push(m[1]);
  const { tainted, rootOf } = taintedNames(code, literal, clearers);

  /** Every native-path expression in the file, as [start, end) spans. */
  const producers = [];
  for (const m of codeMatches(code, literal, PRODUCER_RE)) {
    const open = m.index + m[0].length - 1;
    const end = matchParen(code, literal, open);
    if (end < 0) continue;
    producers.push({ start: m.index, end, text: code.slice(m.index, end) });
  }

  // -- RULE native-path-split ------------------------------------------------------------------
  // DEFECT 1's root: pathMatcher splits its pattern on '/', so a native path fed into '/'-space
  // machinery is a path on neither platform. `.split(path.sep)` is the correct spelling; so is
  // splitting a value git handed you, which is why only NATIVE expressions are flagged.
  const SPLIT_RE = /^\s*\.\s*split\s*\(\s*['"]\/['"]/;
  for (const p of producers) {
    if (SPLIT_RE.test(code.slice(p.end, p.end + 40))) {
      add(p.start, 'native-path-split', `${p.text.slice(0, 60)} .split('/')`,
        "split on path.sep, or normalise to forward slashes first (`.replace(/\\\\/g, '/')`)");
    }
  }
  for (const name of tainted) {
    const re = new RegExp(`\\b${name}\\s*\\.\\s*split\\s*\\(\\s*['"]/['"]`, 'g');
    for (const m of codeMatches(code, literal, re)) {
      add(m.index, 'native-path-split', `${name}.split('/') — ${name} holds a native path`,
        "split on path.sep, or normalise to forward slashes first (`.replace(/\\\\/g, '/')`)");
    }
  }

  // -- RULE native-path-compare ----------------------------------------------------------------
  // The sibling class src/paths.mjs closed. The guard in test/unit/no-network.test.mjs already
  // catches `path.resolve(...) === ...`; this extends the same shape to every native-path
  // producer, which is how src/team/fleet.mjs's `path.dirname(id) === p` — git's spelling of a
  // path compared against the walker's — stayed invisible for the whole life of that guard.
  // Unanchored at the tail on purpose: an earlier `(.*)$` without the `s` flag could not match
  // when the 120-character window ran past a newline, so `path.dirname(id) === p` in
  // src/team/fleet.mjs — the one real production instance in the tree — was silently not reported.
  // A rule that fires only when the rest of the line happens to be short is exactly the
  // absence-of-evidence failure this whole lint exists to prevent.
  const CMP_AFTER = /^\s*\)*\s*(===|!==)\s*([\s\S]{0,40})/;
  const MEMBER_AFTER = /^\s*\.\s*(startsWith|endsWith|includes)\s*\(\s*([\s\S]{0,40})/;
  const CMP_FIX = 'compare through samePathAsync / underOrEqualAsync / findByPath in src/paths.mjs';
  const CONTAINS_FIX = 'containment is underOrEqualAsync in src/paths.mjs — a raw prefix test '
    + 'folds no case and resolves no symlink';
  // `if (import.meta.url === pathToFileURL(process.argv[1]).href)` is this repo's own idiom, in
  // scripts/generate-hosts.mjs, check-published-numbers.mjs and milestone.mjs, with the reason
  // written down at generate-hosts.mjs:108. Naming it here is what makes the finding actionable
  // rather than a lecture about paths.mjs helpers that do not apply to a module-entry check.
  const MAIN_MODULE_FIX = 'this is the main-module check: use this repo\'s own idiom, '
    + '`import.meta.url === pathToFileURL(process.argv[1]).href` — a raw comparison silently '
    + 'reports "not the entry point" on a case or short-name mismatch, and the script then does '
    + 'nothing while exiting 0';
  const isMainModule = (a, b) => /import\s*\.\s*meta|process\s*\.\s*argv/.test(`${a} ${b}`);

  for (const p of (rel.endsWith('src/paths.mjs') ? [] : producers)) {
    // canonicalPath() IS the canonicaliser, so comparing its output is the sanctioned form — it is
    // what samePathAsync does internally. It is only wrong when the case is not folded too, which
    // is why the exemption is `foldCase(await canonicalPath(x))` and not `canonicalPath` by name.
    const before = code.slice(Math.max(0, p.start - 60), p.start);
    if (/\bcanonicalPath|\brealpath/i.test(p.text) && /\bfoldCase\s*\(\s*(?:await\s+)?$/.test(before)) continue;

    const after = code.slice(p.end, p.end + 120);
    const cmp = CMP_AFTER.exec(after);
    if (cmp && !LITERAL_OPERAND_RE.test(cmp[2])) {
      // `path.dirname(p) === p` walks to the filesystem root. Both sides are one value, so no
      // cross-source mismatch is possible — flagging it would be a pure false positive.
      const arg = /\(\s*([A-Za-z_$][\w$.]*)\s*\)$/.exec(p.text)?.[1];
      const rhs = /^\s*([A-Za-z_$][\w$.]*)/.exec(cmp[2])?.[1];
      if (!(arg && rhs && arg === rhs)) {
        add(p.start, 'native-path-compare', `${p.text.slice(0, 60)} ${cmp[1]} ${cmp[2].slice(0, 30)}`,
          isMainModule(p.text, cmp[2]) ? MAIN_MODULE_FIX : CMP_FIX);
      }
    }
    const mem = MEMBER_AFTER.exec(after);
    if (mem && !LITERAL_OPERAND_RE.test(mem[2]) && !/^\s*path\s*\.\s*sep/.test(mem[2])) {
      add(p.start, 'native-path-compare', `${p.text.slice(0, 60)}.${mem[1]}(${mem[2].slice(0, 30)})`, CONTAINS_FIX);
    }
    if (/(===|!==)\s*$/.test(before) && !/['"`]\s*(?:===|!==)\s*$/.test(before)) {
      add(p.start, 'native-path-compare', `... ${/(===|!==)\s*$/.exec(before)?.[1]} ${p.text.slice(0, 60)}`,
        isMainModule(before, p.text) ? MAIN_MODULE_FIX : CMP_FIX);
    }
    // A native path as the ARGUMENT of a containment test — `list.includes(path.join(dir, 'x'))`.
    //
    // NEVER-WORSE, and this one is load-bearing: `file.endsWith(path.join('.cline', 'data',
    // 'settings', 'x.json'))` in test/unit/host-manifest.test.mjs is not the defect, it is the
    // CURE — path.join over string literals is exactly how you spell a relative fragment that
    // matches on both separators, and flagging it would push people back to the hardcoded '/'
    // this lint exists to remove. Only a producer carrying a VARIABLE — an absolute path that
    // came from somewhere else — is a cross-source comparison.
    const takesVariable = /\(\s*[A-Za-z_$]/.test(p.text.slice(p.text.indexOf('(')))
      || /,\s*[A-Za-z_$][\w$.]*\s*[,)]/.test(p.text);
    if (takesVariable && /\.\s*(?:startsWith|endsWith|includes)\s*\(\s*$/.test(before)) {
      add(p.start, 'native-path-compare', `....includes(${p.text.slice(0, 60)})`, CONTAINS_FIX);
    }
  }

  // THE SAME RULE ON THE COMMON SPELLING: `abs === other`, not `path.resolve(x) === other`.
  //
  // Producer-adjacency alone catches how the historical defects HAPPENED to be written; it does
  // not catch the shape. Measured: with only the adjacent form, planting
  // `const home = path.join(process.cwd(), 'a'); const same = home === process.env.HOME;` into
  // src/ left the gate GREEN — a lint that catches one bad call and not the shape is worthless.
  // The origin map above is what keeps `parent === dir` (one value, walked to the root) out of it.
  if (!rel.endsWith('src/paths.mjs')) {
    for (const name of tainted) {
      const CMP = new RegExp(`\\b${name}\\s*(===|!==)\\s*([^;\\n]{0,40})|([\\w$.\\]]+)\\s*(===|!==)\\s*${name}\\b`, 'g');
      for (const m of codeMatches(code, literal, CMP)) {
        const other = (m[2] ?? m[3] ?? '').trim();
        const op = m[1] ?? m[4];
        if (!other || LITERAL_OPERAND_RE.test(other)) continue;
        // THE OPERAND IS THE LEADING TOKEN, not the rest of the line. `parent === dir) break` was
        // captured whole, so `dir) break` never matched a bare identifier, the same-origin
        // exemption never applied, and the root-walk idiom in src/jj.mjs and
        // src/integrate/adapters.mjs was reported as a defect. An exemption that cannot be reached
        // is not an exemption.
        const otherName = /^([A-Za-z_$][\w$]*)(?![\w$.[(])/.exec(other)?.[1];
        if (otherName && rootOf(otherName) === rootOf(name)) continue;   // a value vs its own derivative
        add(m.index, 'native-path-compare',
          `${name} ${op} ${other.slice(0, 30)} — ${name} holds a native path`, CMP_FIX);
      }
      const CONTAINS = new RegExp(`\\b${name}\\s*\\.\\s*(startsWith|endsWith|includes)\\s*\\(\\s*([^;\\n)]{0,40})`, 'g');
      for (const m of codeMatches(code, literal, CONTAINS)) {
        const arg = m[2].trim();
        if (!arg || LITERAL_OPERAND_RE.test(arg) || /^path\s*\.\s*sep/.test(arg)) continue;
        const argName = /^([A-Za-z_$][\w$]*)(?![\w$.[(])/.exec(arg)?.[1];
        if (argName && rootOf(argName) === rootOf(name)) continue;
        add(m.index, 'native-path-compare',
          `${name}.${m[1]}(${arg.slice(0, 30)}) — ${name} holds a native path`, CONTAINS_FIX);
      }
    }
  }

  // -- RULE native-path-pattern ----------------------------------------------------------------
  // DEFECT 1 EXACTLY, in both halves.
  //
  //   the build:  pathMatcher(`${abs}/${suffix}`)   — a '/'-joined pattern out of a native path
  //   the match:  re.test(p) where p advances by path.dirname(p)  — a native path into that regex
  //
  // Either half alone is the bug; the fix normalised both. A lint that only saw the build would
  // miss the loop that walked ancestors with path.dirname, which was the same commit's other half.
  for (const m of codeMatches(code, literal, MATCHER_RE)) {
    const open = m.index + m[0].length - 1;
    const end = matchParen(code, literal, open);
    if (end < 0) continue;
    for (const tpl of templates) {
      if (tpl.start < open || tpl.end > end) continue;
      let text = code.slice(tpl.start, tpl.end);
      for (const it of tpl.interps) text = text.replace(code.slice(it.start, it.end), '');
      if (!text.includes('/')) continue;                       // not a '/'-space pattern at all
      for (const it of tpl.interps) {
        const expr = code.slice(it.start, it.end);
        if (isNative(expr, tainted, clearers)) {
          add(it.start, 'native-path-pattern',
            `a '/'-built pattern interpolates the native path \`${expr.trim().slice(0, 40)}\``,
            "normalise to forward slashes before building the pattern (`p.replace(/\\\\/g, '/')`)");
        }
      }
    }
  }
  const TEST_RE = /\.\s*test\s*\(\s*([^)]*)\)/g;
  for (const m of codeMatches(code, literal, TEST_RE)) {
    const arg = m[1];
    if (!isNative(arg, tainted, clearers)) continue;
    add(m.index, 'native-path-pattern',
      `a regex is matched against the native path \`${arg.trim().slice(0, 40)}\``,
      "a pattern written with '/' matches nothing on Windows — normalise the subject to forward slashes first");
  }

  // -- RULE devnull-to-git ---------------------------------------------------------------------
  // DEFECT 4. Keyed on the TOOL, never on a house style: src/jj.mjs is correct to use os.devNull
  // and would be broken by "always use /dev/null".
  const DEVNULL_RE = /\bos\s*\.\s*devNull\b|(?<![.\w])devNull\b/g;
  for (const m of codeMatches(code, literal, DEVNULL_RE)) {
    const before = code.slice(Math.max(0, m.index - 400), m.index);
    const key = /([A-Za-z_$][\w$]*|['"][^'"]*['"])\s*:\s*$/.exec(before)?.[1] ?? '';
    const gitKey = /^['"]?GIT_/i.test(key);
    // The innermost enclosing call: `execFile('git', ...)` and `git([...], { env })` both name the
    // tool right there, which is the only thing that decides which /dev/null is correct.
    let depth = 0;
    let gitCall = false;
    for (let i = m.index - 1; i >= 0 && i > m.index - 4000; i--) {
      if (literal[i]) continue;
      if (code[i] === ')') depth++;
      else if (code[i] === '(') {
        if (depth === 0) {
          const callee = nameBefore(code, i);
          const args = code.slice(i, Math.min(code.length, i + 40));
          if (/(?:^|\.)git\w*$/i.test(callee) || /^\(\s*['"]git['"]/.test(args)) gitCall = true;
          break;
        }
        depth--;
      }
    }
    if (gitKey || gitCall) {
      add(m.index, 'devnull-to-git',
        `os.devNull reaches git${key ? ` (as ${key})` : ''}`,
        "use the string '/dev/null': git-for-windows is MSYS and rejects \\\\.\\nul with "
        + "`fatal: unable to access '//./nul'`, killing the fixture before it tests anything");
    }
  }

  if (!opts.programs) return dedupe(out);

  // -- RULE native-path-in-source --------------------------------------------------------------
  // DEFECTS 2 AND 3, which are one defect seen from each end: a native path pasted into generated
  // source is not that path. `C:\Users\x` makes `\U` and `\x` escapes, and a path spelled
  // CORRECTLY in source carries doubled backslashes that are not in the real path. Only
  // JSON.stringify crosses that boundary safely, on every platform.
  for (const tpl of templates) {
    let text = code.slice(tpl.start, tpl.end);
    for (const it of tpl.interps) text = text.replace(code.slice(it.start, it.end), '');
    if (!INLINE_PROGRAM_RE.test(text)) continue;
    for (const it of tpl.interps) {
      const expr = code.slice(it.start, it.end);
      if (SOURCE_SAFE_RE.test(expr)) continue;
      if (!isNative(expr, tainted, clearers) && !PATHISH_EXPR_RE.test(expr.trim())) continue;
      add(it.start, 'native-path-in-source',
        `a path is interpolated raw into generated source: \`${expr.trim().slice(0, 40)}\``,
        'wrap it in JSON.stringify() — a raw C:\\Users\\x makes \\U and \\x escape sequences and '
        + 'the program under test is corrupted before it is parsed');
    }
  }

  return dedupe(out);
}

/**
 * One line, one rule, one finding. `path.resolve(argv[1]) === fileURLToPath(import.meta.url)` is a
 * single defect that both the left-operand and right-operand rules see; reporting it twice makes a
 * clean tree look dirtier than it is, and a noisy gate is a gate people learn to skim.
 */
const dedupe = (findings) => {
  const seen = new Set();
  return findings.filter((f) => {
    const k = `${f.file}|${f.line}|${f.rule}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * The whole check, factored so the same code can be pointed at a planted fixture.
 *
 * `stats.files` is not decoration. "No findings" and "read no files" are the same output, and the
 * second one is the defect this repo names by name: absence of evidence reported as evidence of
 * absence. A caller that mistypes a root, or a CI checkout that lands somewhere else, gets a
 * confident green from a check that opened nothing. The count is what lets the caller refuse it.
 *
 * @param {string} base
 * @param {{ codeRoots?: string[], programRoots?: string[], stats?: { files: number } }} [opt]
 */
export async function lintTree(base = ROOT, opt = {}) {
  const CODE = opt.codeRoots ?? ['src', 'bin', 'scripts'];
  const PROGRAMS = opt.programRoots ?? ['test', 'eval'];
  /** @type {Finding[]} */
  const out = [];
  let files = 0;
  for (const [roots, opts] of [[CODE, {}], [PROGRAMS, { programs: true }]]) {
    for (const r of roots) {
      for (const file of await sourceFiles(path.join(base, String(r)))) {
        files++;
        const rel = path.relative(base, file).split(path.sep).join('/');
        out.push(...fileFindings(rel, await fs.readFile(file, 'utf8'), opts));
      }
    }
  }
  if (opt.stats) opt.stats.files = files;
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

export const format = (f) => `${f.file}:${f.line}  [${f.rule}]  ${f.what}\n      -> ${f.fix}`;

// This repo's main-module idiom — see scripts/generate-hosts.mjs for why the obvious spelling
// silently makes the script a no-op on Windows. A lint that broke its own rule in its own CLI
// entry point would be self-refuting, and would also stop running on the platform it defends.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stats = { files: 0 };
  const findings = await lintTree(ROOT, { stats });
  // A GATE THAT CANNOT FAIL IS NOT A GATE. Zero findings out of zero files is the same printout as
  // zero findings out of two hundred, and only one of them means anything.
  if (stats.files < 50) {
    console.error(`native-path lint: only ${stats.files} source file(s) were read — refusing to `
      + 'report "clean" on a tree it did not scan. Run this from the repository.');
    process.exit(2);
  }
  if (findings.length === 0) {
    console.log(`native-path lint: clean — ${stats.files} source files, no native path used as text.`);
    process.exit(0);
  }
  console.error(`native-path lint: ${findings.length} offence(s).\n`);
  for (const f of findings) console.error(format(f));
  console.error(
    '\nEvery one of these is the class that put four Windows-only defects in this repo — a guard\n'
    + 'that allowed destructive commands, a fixture that died before it tested anything, and two\n'
    + 'silent under-refusals. Do path STRING work in forward-slash space; use src/paths.mjs to\n'
    + 'compare; reserve the path module for path operations.',
  );
  process.exit(1);
}
