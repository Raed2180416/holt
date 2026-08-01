// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * The declared-body equivalence primitive behind `duplicates()` — `layoutNormalisedBody` and
 * `declaredBodiesAgree` in src/analyze.mjs.
 *
 * WHY THIS FILE EXISTS. The duplicate gate has been wrong in both directions inside one release.
 * First it counted a bare NAME match as evidence, and two agents who independently reached for
 * `process` read as duplicate work (precision 0.75). The fix required the two DECLARED BODIES to
 * agree — but it compared them as TEXT, and text equality answers "did they type the same bytes",
 * not "did they build the same thing". A genuine duplicate almost never types the same bytes: one
 * wraps the signature, the other keeps it on one line; one indents with tabs, the other with four
 * spaces. Every one of those was a mismatch and the real duplicate went unreported — a recall
 * regression invisible to any corpus that plants byte-identical bodies, which is exactly what
 * bench50 plants. The comparison is now a whitespace-normalised, string-literal-aware token
 * stream.
 *
 * The e2e tests in test/e2e/detection.test.mjs pin the three worktree-visible outcomes (a
 * reformatted duplicate is found; a name coincidence is not; a string literal's internal spacing
 * is content). They cannot reach the lexer's CONTRACT, which is where both regressions actually
 * live and where the next one will:
 *
 *   1. layout collapses           — reindent and rewrap do not change the stream
 *   2. literals are verbatim      — whitespace inside a quote is data, never layout
 *   3. tokens never fuse          — collapsing a run must not weld two identifiers into a third
 *   4. operator spacing is kept   — `a - -b` and `a--b` are different programs
 *   5. unsure means null          — and null means the STRICT verdict stands, never a match
 *
 * Rule 5 is the load-bearing one and the only one with no observable worktree shape: an unsure
 * lexer must cost RECALL and never PRECISION. Every "these agree" assertion below is therefore
 * paired with a "and these, which merely look similar, do NOT" assertion — a normaliser that
 * returned a constant, or an `agree` that returned true, would otherwise pass half of a one-sided
 * suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutNormalisedBody, declaredBodiesAgree } from '../../src/analyze.mjs';

/** The shape duplicates() caches per (workstream, symbol) and hands to declaredBodiesAgree. */
const body = (text) => ({ text, tokens: layoutNormalisedBody(text) });

/* ------------------------------------------------- 1. layout collapses ---- */

test('TOKENS: reindenting and rewrapping the same code yields the same token stream', () => {
  // Four-space indent, signature wrapped over four lines.
  const wrapped = 'function f(\n    a,\n    b\n) {\n    return a + b;\n}';
  // Tabs, signature on one line, a blank line in the middle. Same tokens, different layout.
  const tight = 'function f(a, b) {\n\n\treturn a + b;\n}';

  assert.notEqual(wrapped, tight, 'ANTI-VACUITY: the two inputs must not be byte-identical');
  assert.equal(layoutNormalisedBody(wrapped), layoutNormalisedBody(tight));
  assert.equal(declaredBodiesAgree(body(wrapped), body(tight)), true,
    'a reformatted body is the same code and must agree');
});

test('TOKENS: blank lines are layout, and a delimiter absorbs the whitespace beside it', () => {
  assert.equal(layoutNormalisedBody('a = 1;\n\n\nb = 2;'), layoutNormalisedBody('a = 1;\nb = 2;'));
  // The delimiter rule is what makes re-wrapping work at all: `f(\n  a,\n  b\n)` must reduce to
  // `f(a,b)`, or every argument list wrapped differently would read as different code.
  assert.equal(layoutNormalisedBody('f(\n  a,\n  b\n)'), 'f(a,b)');
});

/**
 * The off-side-rule justification, made checkable. readDeclaredBody per-line `.trim()`s before
 * this function ever runs, so indentation is already gone; what normalisation adds for Python is
 * erasing the line BOUNDARY. Two valid Python bodies cannot differ in only that — splitting or
 * joining statements needs a `;` or a `\`, both non-whitespace characters this keeps — so the one
 * new equivalence created here is `def f(): return 1` against the same body over two lines, which
 * is the same code and is what the duplicate question wants.
 */
test('TOKENS: an off-side-rule body written on one line matches the same body over two', () => {
  assert.equal(layoutNormalisedBody('def f():\n    return 1'), layoutNormalisedBody('def f(): return 1'));
  // ...and the separator that Python actually uses to join statements is NOT erased, so two
  // genuinely different Python bodies stay different.
  assert.notEqual(layoutNormalisedBody('a = 1\nb = 2'), layoutNormalisedBody('a = 1; b = 2'));
});

/* --------------------------------------------- 2. literals are verbatim ---- */

test('TOKENS: whitespace INSIDE a string literal is data, not layout', () => {
  const wide = 'const s = "col   sep";';
  const narrow = 'const s = "col sep";';
  assert.notEqual(layoutNormalisedBody(wide), layoutNormalisedBody(narrow),
    'two different strings must not normalise to one');
  assert.equal(declaredBodiesAgree(body(wide), body(narrow)), false,
    'these are two different programs and the gate must keep saying so');

  // ...while layout OUTSIDE the literal on the same body still collapses.
  assert.equal(layoutNormalisedBody('const s =\n    "col   sep";'), layoutNormalisedBody(wide));
});

test('TOKENS: single, double and backtick literals all preserve their contents', () => {
  for (const q of ['"', "'", '`']) {
    assert.notEqual(
      layoutNormalisedBody(`x = ${q}a  b${q};`),
      layoutNormalisedBody(`x = ${q}a b${q};`),
      `whitespace inside a ${q}-quoted literal must be significant`,
    );
  }
});

test('TOKENS: an escaped quote does not close the literal', () => {
  // If the backslash were ignored, the literal would close at the escaped quote and the two
  // spaces after it would be read as LAYOUT and collapse — silently equating two different
  // strings. The trailing `;` proves the lexer resumed in code, not inside a runaway literal.
  const two = 'const s = "a\\"  b";';
  const one = 'const s = "a\\" b";';
  assert.equal(layoutNormalisedBody(two), 'const s = "a\\"  b";');
  assert.notEqual(layoutNormalisedBody(two), layoutNormalisedBody(one));
});

/* ------------------------------------------------ 3. tokens never fuse ---- */

test('TOKENS: collapsing a whitespace run never welds two identifiers into a third', () => {
  // The failure this guards: if a run between two non-delimiters collapsed to NOTHING rather
  // than to one separator, `let delay` would become `letdelay` and could then match an unrelated
  // body that really does declare something called `letdelay`.
  assert.equal(layoutNormalisedBody('let delay'), 'let delay');
  assert.notEqual(layoutNormalisedBody('let delay'), layoutNormalisedBody('letdelay'));
  assert.equal(declaredBodiesAgree(body('let delay'), body('letdelay')), false);
  // A newline is a separator too — joining lines must not fuse the tokens across the join.
  assert.equal(layoutNormalisedBody('return\nfoo'), 'return foo');
  assert.notEqual(layoutNormalisedBody('return\nfoo'), layoutNormalisedBody('returnfoo'));
});

/* -------------------------------------------- 4. operator spacing kept ---- */

test('TOKENS: whitespace around OPERATORS stays significant', () => {
  // The mirror image of the delimiter rule, and the reason operators are excluded from it:
  // these pairs are different token sequences, so they must keep disagreeing.
  assert.notEqual(layoutNormalisedBody('a - -b'), layoutNormalisedBody('a--b'));
  assert.notEqual(layoutNormalisedBody('a < = b'), layoutNormalisedBody('a <= b'));
  assert.equal(declaredBodiesAgree(body('x = a - -b'), body('x = a--b')), false);
});

/* ------------------------------------------------ 5. unsure means null ---- */

test('TOKENS: an unterminated quote returns null rather than guessing', () => {
  // A 40-line window that truncated mid-string, a Lisp quote, an apostrophe in a trailing
  // comment, a lone Rust lifetime: all look identical to an unterminated literal from here.
  assert.equal(layoutNormalisedBody('const s = "cut off by the window'), null, 'truncated literal');
  assert.equal(layoutNormalisedBody("(defun f () '(a b))"), null, 'Lisp quote');
  assert.equal(layoutNormalisedBody("foo(); // don't"), null, 'apostrophe in a trailing comment');
  assert.equal(layoutNormalisedBody("fn f(s: &'a str) {}"), null, 'Rust lifetime');
});

test('SAFETY: an unsure lexer costs RECALL, never PRECISION', () => {
  // THE contract. When either side could not be lexed, the strict textual verdict stands: these
  // two differ only in layout outside the (unterminated) quote, and a lexer that "helpfully"
  // guessed would call them equal. It must not.
  const a = "x = 'a";
  const b = "x =    'a";
  assert.equal(layoutNormalisedBody(a), null);
  assert.equal(declaredBodiesAgree(body(a), body(b)), false,
    'null tokens must fall back to the strict comparison, never to a match');
});

test('SAFETY: apostrophes that happen to PAIR are still conservative, not a guess', () => {
  // The subtle half of the bail-out. An odd number of apostrophes is unterminated and returns
  // null; an EVEN number pairs up and is read as a literal that is not one — here `'a>(s: &'`
  // from a Rust signature. That is still safe, and this pins why: the pseudo-literal is kept
  // VERBATIM, so it is strictly harder to match, never easier. The mis-lex can therefore only
  // cost recall (these two differ by one space inside the pseudo-literal and stop agreeing), and
  // can never invent an agreement between two bodies that are not textually equal there.
  const spaced = "fn f<'a>(s: &'a str) {}";
  const tight = "fn f<'a>(s:&'a str) {}";
  assert.notEqual(layoutNormalisedBody(spaced), null, 'ANTI-VACUITY: an even count must NOT take the null path');
  assert.ok(layoutNormalisedBody(spaced).includes("'a>(s: &'"), 'the pseudo-literal is preserved verbatim');
  assert.equal(declaredBodiesAgree(body(spaced), body(tight)), false,
    'a mis-lexed literal must fail closed (recall), never open (precision)');
});

test('SAFETY: byte-identical bodies agree even when neither can be lexed', () => {
  // The guarantee the body gate was not allowed to break: two worktrees checked out at the same
  // commit have byte-identical declarations, and they were reported as duplicates before any of
  // this existed. The short-circuit on `text` is what preserves that for a body the lexer bails
  // on — without it, a Rust or Lisp duplicate would go silently unreported.
  const rust = "fn parse(s: &'a str) -> Token {}";
  assert.equal(layoutNormalisedBody(rust), null, 'ANTI-VACUITY: this body must really be un-lexable');
  assert.equal(declaredBodiesAgree(body(rust), body(rust)), true,
    'identical bytes are the same code whatever the lexer thinks');
});
