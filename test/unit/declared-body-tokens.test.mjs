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
 *   6. the window is the body     — a NESTED declaration does not end it; a sibling does
 *
 * Rule 6 was added after the third regression in the same feature, and it is the one none of the
 * others could have caught: the comparison was correct and the text handed to it was wrong. See
 * the section-6 preamble.
 *
 * Rule 5 is the load-bearing one and the only one with no observable worktree shape: an unsure
 * lexer must cost RECALL and never PRECISION. Every "these agree" assertion below is therefore
 * paired with a "and these, which merely look similar, do NOT" assertion — a normaliser that
 * returned a constant, or an `agree` that returned true, would otherwise pass half of a one-sided
 * suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutNormalisedBody, declaredBodiesAgree, declaredBodyFromLines } from '../../src/analyze.mjs';

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

/* ----------------------------------------- 6. the window the lexer is fed ---- */

/**
 * WHY THIS SECTION EXISTS. Everything above pins how two bodies are COMPARED. None of it can
 * catch the defect that shipped: the bodies handed to the comparison were the wrong text. The
 * window ended at the next declaration line of any kind, and the regex fallback — the extractor
 * every user without universal-ctags runs — reports a `const` inside a function as a declaration.
 * So a function's "declared body" was its signature line alone, two different functions sharing a
 * name and an arity agreed, and holt reported duplicated work that did not exist. It was green on
 * every machine with ctags installed and red on all three `core` CI jobs, whose contract is no
 * optional backends, for the entire life of the feature.
 *
 * The window is therefore pinned here directly, at a granularity no worktree fixture can reach
 * without also depending on which tools the grading machine has.
 */

const L = (s) => s.split('\n');

test('WINDOW: a nested declaration is part of the body, not the end of it', () => {
  const src = L([
    'export function renderBanner(name) {',
    '  const sep = "col   sep";',
    '  return sep + name;',
    '}',
  ].join('\n'));
  // What the regex fallback reports for this file: the function at 1, the binding at 2.
  const body = declaredBodyFromLines(src, 1, [1, 2]);
  assert.ok(body.includes('col   sep'),
    `the binding's own line is inside the function body, got: ${JSON.stringify(body)}`);
  assert.ok(body.includes('return sep + name;'), 'and so is everything after it');
});

test('WINDOW: ANTI-VACUITY — a SIBLING declaration still ends the body', () => {
  // The half that proves the fix is a nesting rule and not "boundaries were switched off".
  const src = L([
    'function first() {',
    '  return 1;',
    '}',
    'function second() {',
    '  return 2;',
    '}',
  ].join('\n'));
  const body = declaredBodyFromLines(src, 1, [1, 4]);
  assert.ok(body.includes('return 1;'), 'the first function\'s own body is included');
  assert.ok(!body.includes('return 2;'),
    `the next same-level declaration must end the window, got: ${JSON.stringify(body)}`);
});

test('WINDOW: nesting is judged in columns, so tabs and spaces agree', () => {
  const tabbed = L('function f() {\n\tconst x = 1;\n\treturn x;\n}');
  const spaced = L('function f() {\n    const x = 1;\n    return x;\n}');
  for (const [name, src] of [['tabs', tabbed], ['spaces', spaced]]) {
    const body = declaredBodyFromLines(src, 1, [1, 2]);
    assert.ok(body.includes('return x;'), `${name}: the nested binding must not truncate the body`);
  }
  // And the two really are the same program once layout is normalised — the point of the fix.
  assert.equal(
    layoutNormalisedBody(declaredBodyFromLines(tabbed, 1, [1, 2])),
    layoutNormalisedBody(declaredBodyFromLines(spaced, 1, [1, 2])));
});

test('WINDOW: a method is nested inside its class but a sibling of the next method', () => {
  const src = L([
    'class Parser {',       // 1
    '  parse(s) {',         // 2
    '    return s;',        // 3
    '  }',                  // 4
    '  render(s) {',        // 5
    '    return s + "!";',  // 6
    '  }',                  // 7
    '}',                    // 8
  ].join('\n'));
  const decls = [1, 2, 5];
  const klass = declaredBodyFromLines(src, 1, decls);
  assert.ok(klass.includes('return s + "!";'), 'the class body spans both of its methods');

  const method = declaredBodyFromLines(src, 2, decls);
  assert.ok(method.includes('return s;'), 'the method keeps its own body');
  assert.ok(!method.includes('return s + "!";'),
    `the next method is a sibling and must end the window, got: ${JSON.stringify(method)}`);
});

test('WINDOW: an off-side language nests by indentation with no braces at all', () => {
  const src = L([
    'def render(name):',      // 1
    '    sep = "col   sep"',  // 2
    '    return sep + name',  // 3
    'def other():',           // 4
    '    return 0',           // 5
  ].join('\n'));
  const body = declaredBodyFromLines(src, 1, [1, 2, 4]);
  assert.ok(body.includes('col   sep'), 'the indented binding belongs to render');
  assert.ok(!body.includes('return 0'), 'the next def is a sibling and ends the window');
});

test('WINDOW: the hard cap still bounds a body with no sibling after it', () => {
  const src = L(['function f() {', ...Array.from({ length: 80 }, (_, i) => `  const v${i} = ${i};`), '}'].join('\n'));
  const body = declaredBodyFromLines(src, 1, [1]);
  assert.ok(body.split('\n').length <= 40, `window must stay capped, got ${body.split('\n').length} lines`);
  assert.ok(body.includes('const v0 = 0;'), 'ANTI-VACUITY: the cap must not empty the body');
});

test('WINDOW: unreadable inputs are null, never an empty string that could match', () => {
  // null is UNKNOWN and the caller fails open on it; '' would be a body that agrees with every
  // other empty body, which is precisely the false duplicate this whole section exists to stop.
  assert.equal(declaredBodyFromLines(L('a = 1'), 99, []), null, 'a line past the end is unreadable');
  assert.equal(declaredBodyFromLines(L('a = 1'), 0, []), null, 'line numbers are 1-based');
  assert.equal(declaredBodyFromLines(L('   \n   '), 1, []), null, 'a body of only blank lines is unknown');
  assert.equal(declaredBodyFromLines(L('// just a comment'), 1, []), null,
    'a body of only comments is unknown, not the empty match');
});
