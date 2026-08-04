/**
 * holt — minified JS detection.
 *
 * Minified JS files produce wrong symbol counts with the regex fallback: the fallback is
 * line-oriented, and a minified file is one or two enormous lines, so it matches the first
 * declaration and reports one symbol for a file that contains hundreds. These tests cover the
 * detection heuristic and the warning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMinified, minifiedFilesWarning, fallbackExtract } from '../../src/symbols.mjs';

test('minified: isMinified detects a single-line minified bundle', () => {
  // A real minified file: one line, thousands of chars, semicolon-separated.
  const minified = 'var a=function(){return 1};var b=function(){return 2};' + 'var c=1;'.repeat(200);
  assert.ok(minified.length > 500);
  assert.equal(isMinified(minified), true);
});

test('minified: isMinified detects a two-line minified file by average line length', () => {
  // Two lines, each >500 chars on average.
  const long = 'x'.repeat(800) + ';';
  const content = long + '\n' + long;
  assert.equal(isMinified(content), true);
});

test('minified: isMinified does NOT flag normal source code', () => {
  const src = [
    'export function foo() {',
    '  return 1;',
    '}',
    '',
    'export const bar = () => 2;',
  ].join('\n');
  assert.equal(isMinified(src), false);
});

test('minified: isMinified does NOT flag a long-but-real config table', () => {
  // A generated config table can have long lines, but average stays under 500.
  const lines = Array.from({ length: 50 }, (_, i) => `  { id: ${i}, name: "item-${i}", value: "${'x'.repeat(60)}" },`);
  assert.equal(isMinified(lines.join('\n')), false);
});

test('minified: isMinified handles edge cases without throwing', () => {
  assert.equal(isMinified(''), false);
  assert.equal(isMinified(null), false);
  assert.equal(isMinified(undefined), false);
  // Binary content (NUL byte) is not minified — it is not text.
  assert.equal(isMinified('a\0b'.repeat(600)), false);
  // A short single line is not minified.
  assert.equal(isMinified('var x = 1;'), false);
});

test('minified: the regex fallback undercounts a minified file', () => {
  // PROOF OF THE DEFECT. A minified file with 5 functions on one line yields 1 symbol under
  // the regex fallback (it matches the first declaration only). This is the wrong count
  // isMinified() exists to flag.
  const minified = 'function a(){}function b(){}function c(){}function d(){}function e(){}'
    + '/*padding*/'.repeat(50); // pad to >500 chars so isMinified fires
  assert.ok(minified.length > 500, 'fixture must be >500 chars');
  const syms = fallbackExtract('bundle.min.js', minified);
  assert.ok(syms.length < 5, 'the regex fallback must undercount a minified file');
  assert.equal(isMinified(minified), true, 'and isMinified must flag it');
});

test('minified: minifiedFilesWarning produces a human-readable warning', () => {
  const w = minifiedFilesWarning(['dist/bundle.min.js', 'vendor/lib.min.js']);
  assert.ok(w);
  assert.match(w, /minified/i);
  assert.match(w, /dist\/bundle\.min\.js/);
  assert.match(w, /regex fallback/i);
  assert.match(w, /unreliable/i);
});

test('minified: minifiedFilesWarning truncates a long list', () => {
  const files = Array.from({ length: 10 }, (_, i) => `dist/bundle${i}.min.js`);
  const w = minifiedFilesWarning(files);
  assert.ok(w);
  assert.match(w, /\+5 more/);
});

test('minified: minifiedFilesWarning returns null for an empty list', () => {
  assert.equal(minifiedFilesWarning([]), null);
  assert.equal(minifiedFilesWarning(null), null);
});
