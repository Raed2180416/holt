// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — a JavaScript source scanner that can tell CODE from LITERAL TEXT, byte for byte.
 *
 * WHY THIS EXISTS SEPARATELY FROM test/unit/no-network.test.mjs's `codeOnly()`. That stripper
 * blanks the CONTENTS of every string and template literal, which is exactly right for the
 * question it asks ("is there a network call here?") and exactly wrong for the question the
 * native-path lint asks. The path lint has to read string contents — `.split('/')` is only a
 * defect because of the '/' inside the quotes, and `\`${abs}/${suffix}\`` is only a defect
 * because of the '/' between two interpolations. A stripper that blanks them cannot see the bug
 * it is looking for.
 *
 * So this keeps every byte and reports, per character, whether it is inside a literal. A rule
 * then matches on the CODE shape and rejects any hit whose match starts inside a literal — which
 * gives the path lint the string contents it needs while still refusing to read a comment or a
 * quoted example as if it were code. `const doc = 'path.resolve(a) === b'` is prose; the same
 * text outside quotes is the defect.
 *
 * THE CONTRACT THIS MUST NEVER BREAK, and the reason it is asserted against the real tree rather
 * than a fixture: the output is the SAME LENGTH and the SAME LINE COUNT as the input. The
 * previous generation of this repo's stripper collapsed multi-line comments and templates to a
 * single character, and the measured result was 7,660 of 17,651 lines of src/ and bin/ never
 * being scanned at all while every check reported on the whole file. Absence of evidence,
 * reported as evidence of absence. Preserving offsets is what makes that impossible here: an
 * offset-preserving transform cannot delete a region without leaving the region behind.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Characters (and keywords) after which a `/` begins a REGEX LITERAL rather than a division.
 *
 * Needed because a regex literal is literal text — `/\\/g` in the forward-slash normaliser
 * `p.replace(/\\/g, '/')` must not be read as code, and `/[/]/` must not end the literal at its
 * inner slash. Getting this wrong in the permissive direction is safe here (a mis-read regex only
 * ever costs a rule a hit inside literal text); getting it wrong in the other direction would
 * make a `/` swallow the rest of the file, so the contract test below pins total length.
 */
const REGEX_ALLOWED_BEFORE = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n',
]);
const REGEX_ALLOWED_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield',
  'await', 'case', 'throw',
]);

/**
 * @param {string} src
 * @returns {{ code: string, literal: Uint8Array, templates: Template[] }}
 *   `code` is `src` with every COMMENT character replaced by a space (newlines kept), and nothing
 *   else altered. `literal[i]` is 1 when character i belongs to a string, template TEXT, or regex
 *   literal — the spans a rule must not read as code. A template's `${...}` expression is CODE,
 *   because that is where an interpolated native path actually appears. `templates` records each
 *   template literal with its interpolations, because "a '/' sitting between two interpolations"
 *   is the exact shape of the glob-pattern defect and cannot be seen from a flat character mask.
 *
 * @typedef {{ start: number, end: number, interps: Array<{ start: number, end: number }> }} Template
 */
export function scanSource(src) {
  // split('') and NOT Array.from(): Array.from iterates CODE POINTS, so one emoji in bin/holt.mjs
  // made every later out[i] one slot out of step with src[i] — which blanked 308 newlines that
  // were not comments and made 308 lines of the file invisible to every rule. Exactly the
  // line-collapsing failure the contract test below exists to catch, arriving by a different door.
  const out = src.split('');
  const literal = new Uint8Array(src.length);
  const blankComment = (i) => { if (src[i] !== '\n') out[i] = ' '; };

  /** @type {Template[]} */
  const templates = [];
  /** @type {Array<{ kind: 'template'|'expr', depth: number, tpl?: Template, interpStart?: number }>} */
  const stack = [];
  let i = 0;
  let lastSignificant = '\n';
  let lastWord = '';

  const inTemplateText = () => stack.length > 0 && stack[stack.length - 1].kind === 'template';

  while (i < src.length) {
    const c = src[i];

    if (inTemplateText()) {
      if (c === '\\') { literal[i] = 1; literal[i + 1] = 1; i += 2; continue; }
      if (c === '`') {
        literal[i] = 1;
        const frame = stack.pop();
        if (frame?.tpl) frame.tpl.end = i + 1;
        i++; lastSignificant = '`'; lastWord = '';
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        stack.push({ kind: 'expr', depth: 0, interpStart: i + 2 });
        i += 2; lastSignificant = '{'; lastWord = '';
        continue;
      }
      literal[i] = 1; i++;
      continue;
    }

    // --- ordinary code -------------------------------------------------------------------
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { blankComment(i); i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      blankComment(i); blankComment(i + 1); i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { blankComment(i); i++; }
      if (i < src.length) { blankComment(i); blankComment(i + 1); i += 2; }
      continue;
    }
    if (c === "'" || c === '"') {
      literal[i] = 1; i++;
      while (i < src.length) {
        literal[i] = 1;
        if (src[i] === '\\') { literal[i + 1] = 1; i += 2; continue; }
        if (src[i] === c) { i++; break; }
        if (src[i] === '\n') { i++; break; }   // an unterminated quote never eats the file
        i++;
      }
      lastSignificant = c; lastWord = '';
      continue;
    }
    if (c === '`') {
      literal[i] = 1;
      /** @type {Template} */
      const tpl = { start: i, end: src.length, interps: [] };
      templates.push(tpl);
      stack.push({ kind: 'template', depth: 0, tpl });
      i++;
      continue;
    }
    if (c === '/' && (REGEX_ALLOWED_BEFORE.has(lastSignificant) || REGEX_ALLOWED_KEYWORDS.has(lastWord))) {
      const start = i;
      let cls = false;
      literal[i] = 1; i++;
      let closed = false;
      while (i < src.length && src[i] !== '\n') {
        literal[i] = 1;
        if (src[i] === '\\') { literal[i + 1] = 1; i += 2; continue; }
        if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        else if (src[i] === '/' && !cls) { i++; closed = true; break; }
        i++;
      }
      if (!closed) { literal.fill(0, start, i); i = start + 1; }  // it was a division after all
      else { while (i < src.length && /[a-z]/.test(src[i])) { literal[i] = 1; i++; } }
      lastSignificant = '/'; lastWord = '';
      continue;
    }
    if (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (c === '{') top.depth++;
      else if (c === '}') {
        if (top.depth === 0) {
          stack.pop();
          const owner = stack[stack.length - 1];
          if (owner?.tpl && top.interpStart !== undefined) {
            owner.tpl.interps.push({ start: top.interpStart, end: i });
          }
          i++; lastSignificant = '}'; lastWord = '';
          continue;
        }
        top.depth--;
      }
    }
    if (!/\s/.test(c)) lastSignificant = c;
    else if (c === '\n') lastSignificant = '\n';
    lastWord = /[A-Za-z_$]/.test(c) ? lastWord + c : '';
    i++;
  }

  return { code: out.join(''), literal, templates };
}

/**
 * Every match of `re` in `code` whose FIRST CHARACTER is code, not literal text.
 *
 * Anchoring on the first character rather than the whole span is deliberate: a rule for
 * `path.join(a, b).split('/')` must be allowed to reach into the `'/'` literal it is judging,
 * while `const note = 'path.join(a, b).split(\'/\')'` — the same text as prose — starts inside a
 * literal and is rejected. The rule reads string CONTENTS; it never reads a string as CODE.
 *
 * @param {string} code
 * @param {Uint8Array} literal
 * @param {RegExp} re must carry the `g` flag
 */
export function* codeMatches(code, literal, re) {
  re.lastIndex = 0;
  for (const m of code.matchAll(re)) {
    if (m.index === undefined) continue;
    if (literal[m.index]) continue;
    yield m;
  }
}

/** 1-based line number of a character offset. */
export const lineAt = (code, index) => code.slice(0, index).split('\n').length;

/**
 * Index just past the `)` that closes the `(` at `open`, or -1.
 * Literal-aware, so a `)` inside a string or regex never closes a call.
 */
export function matchParen(code, literal, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (literal[i]) continue;
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Recursively list JavaScript source files under `dir`. */
export async function sourceFiles(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await sourceFiles(p));
    else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(p);
  }
  return out.sort();
}
