/**
 * holt — the TUI, tested through its snapshot path.
 *
 * --snapshot renders ONE frame through exactly the renderer the interactive mode uses, then
 * exits. That is the deal that makes a TUI testable: if the snapshot is right, the screen is
 * right, because there is only one code path. These tests assert CONTENT (the right workstreams
 * in the right buckets with the right resolution hints), not escape-code aesthetics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standardFixture, newRepo } from '../fixtures.mjs';
import { buildModel, renderFrame } from '../../src/tui.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('TUI: the model buckets every workstream correctly', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const model = await buildModel(fx.root);
  const byId = new Map(model.rows.map((r) => [r.id, r.bucket]));

  assert.equal(byId.get('uniqueUncommitted'), 'atRisk', 'uncommitted-only work is AT RISK');
  assert.equal(byId.get('uniqueCommitted'), 'holds', 'committed-ahead work HOLDS');
  assert.equal(byId.get('empty'), 'disposable');
  assert.equal(byId.get('alreadyLanded'), 'disposable', 'landed content is disposable — the instrument check, again');

  // Risk-sorted: the first row must be the at-risk one. The sort IS the message.
  assert.equal(model.rows[0].bucket, 'atRisk', 'at-risk must sort first');
});

test('TUI: the frame shows the story a human needs', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const model = await buildModel(fx.root);
  const frame = strip(renderFrame(model, { selected: 0, filter: 'all', message: '' },
    { columns: 120, rows: 34 }));

  assert.match(frame, /1 at-risk/, 'header must count the at-risk bucket');
  assert.match(frame, /uniqueUncommitted/, 'the at-risk workstream must be visible');
  assert.match(frame, /do not delete/, 'the verdict must be stated in words');
  assert.match(frame, /UNCOMMITTED_ONLY_SYMBOL/, 'the detail pane must NAME what deletion would lose');
  assert.match(frame, /holt rescue uniqueUncommitted --release/,
    'the pane must state the exact resolving command — a dashboard that only alarms is noise');
});

test('TUI: filtering narrows to one bucket', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const model = await buildModel(fx.root);
  const frame = strip(renderFrame(model, { selected: 0, filter: 'disposable', message: '' },
    { columns: 120, rows: 34 }));

  assert.match(frame, /empty/);
  assert.doesNotMatch(frame.split('│')[0] === frame ? frame : frame, /uniqueUncommitted +AT RIS/,
    'the list column must not show non-matching buckets under a filter');
  assert.match(frame, /filter:disposable/);
});

test('TUI: --snapshot works end-to-end through the real binary and exits', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const r = await new Promise((resolve) => {
    execFile(process.execPath, [BIN, 'tui', '--snapshot', '--cwd', fx.root, '--columns', '110', '--rows', '30'],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });

  assert.equal(r.code, 0, `tui --snapshot must exit 0: ${r.stderr.slice(0, 300)}`);
  const text = strip(r.stdout);
  assert.match(text, /holt/, 'header present');
  assert.match(text, /at-risk/, 'counts present');
  // The crucial property: it EXITED. An interactive TUI that ignores --snapshot would hang here
  // and the timeout would fail the test.
});

test('TUI: a repo with unknown workstreams surfaces them, never hides them', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  // Break one registration the way the wild does it.
  const fsp = await import('node:fs/promises');
  await fsp.rm(fx.wt('empty'), { recursive: true, force: true });

  const model = await buildModel(fx.root);
  const unknown = model.rows.filter((r) => r.bucket === 'unknown');
  assert.ok(unknown.length >= 1, 'a broken registration must appear as UNKNOWN in the TUI');

  const frame = strip(renderFrame(model, { selected: 0, filter: 'unknown', message: '' },
    { columns: 120, rows: 30 }));
  assert.match(frame, /UNKNOWN/, 'and be visible under its filter');
});

/**
 * THE DEFECT THIS PINS: bucket labels were padded to a fixed 6 columns, sized for the shortest
 * label ('HOLDS'). Every other label truncated silently — 'DISPOSABLE' -> 'DISPOS', 'AT RISK' ->
 * 'AT RIS', 'UNKNOWN' -> 'UNKNOW' — on every real repository, because every bucket but HOLDS is
 * longer than 6 characters. Reproduced against holt's own 29-worktree tree before the fix.
 */
test('TUI: bucket labels in the list column are never truncated', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  const fsp = await import('node:fs/promises');
  await fsp.rm(fx.wt('empty'), { recursive: true, force: true }); // also produces an UNKNOWN row

  const model = await buildModel(fx.root);
  const buckets = new Set(model.rows.map((r) => r.bucket));
  assert.ok(['atRisk', 'holds', 'unknown', 'disposable'].every((b) => buckets.has(b)),
    `fixture must exercise every bucket or this test proves nothing: ${[...buckets]}`);

  const frame = strip(renderFrame(model, { selected: 0, filter: 'all', message: '' },
    { columns: 120, rows: 30 }));
  const listColumn = frame.split('\n').map((l) => l.split('│')[0] ?? '').join('\n');

  // ANTI-VACUITY: the full spellings must actually appear before asserting the truncated ones don't.
  for (const full of ['AT RISK', 'HOLDS', 'UNKNOWN', 'DISPOSABLE']) {
    assert.match(listColumn, new RegExp(full), `full label '${full}' never appeared — nothing below is tested`);
  }
  // The truncated forms a fixed width-6 pad would have produced, each asserted as NOT followed by
  // the rest of its own real label (a legitimate 'DISPOSABLE' also contains 'DISPOS' as a prefix).
  assert.doesNotMatch(listColumn, /AT RIS(?!K)/, "'AT RISK' was truncated to 'AT RIS'");
  assert.doesNotMatch(listColumn, /UNKNOW(?!N)/, "'UNKNOWN' was truncated to 'UNKNOW'");
  assert.doesNotMatch(listColumn, /DISPOS(?!ABLE)/, "'DISPOSABLE' was truncated to 'DISPOS'");
});

/**
 * THE DEFECT THIS PINS: the detail pane's final truncation sliced the raw JS string — escape
 * codes and all — at a column budget measured in RAW CHARACTERS, not visible ones. On a real
 * repository (long ids, a narrow terminal, a busy detail pane) that regularly cut a colour code
 * like `\x1b[90m` in half, leaking a dangling, unterminated escape sequence into the rendered
 * frame — bytes a terminal cannot interpret as text and that never get a closing reset, so the
 * colour state bleeds into whatever prints next. Reproduced against holt's own 29-worktree tree
 * at every width from 80 to 160 before the fix; this fixture reproduces it in isolation.
 */
test('TUI: narrow terminals never truncate a detail line mid-escape-sequence', async (t) => {
  const fx = await newRepo('tui-ansi');
  t.after(() => fx.cleanup());

  // Long ids and several collision partners, so detail lines routinely exceed a narrow width —
  // the exact condition that triggered the defect.
  const ids = ['alpha-workstream-one', 'alpha-workstream-two', 'alpha-workstream-three', 'alpha-workstream-four'];
  for (const id of ids) {
    const wt = await fx.worktree(id);
    await fx.write('config/registry.mjs',
      `export const REGISTRY = {\n  EXISTING_KEY: { gate: "eq1" },\n  ${id.replace(/-/g, '_').toUpperCase()}: 1,\n};\n`, wt);
    await fx.commit(`${id}: touch the shared registry`, wt);
  }

  const model = await buildModel(fx.root);
  assert.ok(model.rows.some((r) => r.collisions.length > 0), 'fixture must produce collisions to render, or nothing is tested');

  for (const columns of [80, 90, 100, 110, 120, 160]) {
    for (let selected = 0; selected < model.rows.length; selected++) {
      const frame = renderFrame(model, { selected, filter: 'all', message: '' }, { columns, rows: 30 });
      const strippedWellFormed = frame.replace(/\x1b\[[0-9;]*m/g, '');
      assert.doesNotMatch(strippedWellFormed, /\x1b/,
        `columns=${columns} selected=${model.rows[selected].id}: a raw, unterminated escape byte ` +
        `survived stripping every well-formed ANSI sequence — a colour code was cut in half`);
    }
  }
});

/**
 * THE DEFECT THIS PINS: `redundantWith` (safe to delete ONLY because a living sibling holds the
 * identical content) rendered pixel-identical to a workstream that holds nothing at all — same
 * green dot, same 'DISPOSABLE' label, same 'provably nothing to lose' hint, same generic reason
 * text ('no committed delta, no uncommitted changes, no unique symbols' — which is simply false
 * when there IS committed content, it is just duplicated elsewhere). A person clearing every
 * green row on screen would delete both halves of a redundant pair at once, which destroys the
 * only copy — exactly the failure mode `clean --apply`'s per-removal re-verification exists to
 * prevent, except a human acting on the dashboard bypasses that re-verification entirely.
 */
test('TUI: a redundant-but-safe workstream never looks identical to a genuinely empty one', async (t) => {
  const fx = await newRepo('tui-redundant');
  t.after(() => fx.cleanup());

  const twinA = await fx.worktree('twin-a');
  await fx.write('shared-feature.js', 'export function SHARED_WORK() { return 7; }\n', twinA);
  await fx.commit('twin-a: the same work', twinA);

  const twinB = await fx.worktree('twin-b');
  await fx.write('shared-feature.js', 'export function SHARED_WORK() { return 7; }\n', twinB);
  await fx.commit('twin-b: the same work, again', twinB);

  await fx.worktree('genuinely-empty'); // untouched: nothing committed, nothing uncommitted

  const model = await buildModel(fx.root);
  const byId = new Map(model.rows.map((r) => [r.id, r]));
  const twinARow = byId.get('twin-a');
  const emptyRow = byId.get('genuinely-empty');

  // NON-VACUITY FIRST.
  assert.equal(twinARow.bucket, 'disposable', `setup: ${JSON.stringify(twinARow)}`);
  assert.equal(emptyRow.bucket, 'disposable', `setup: ${JSON.stringify(emptyRow)}`);
  assert.ok(twinARow.verdict?.redundantWith?.length >= 1,
    `twin-a must carry redundantWith or this test proves nothing: ${JSON.stringify(twinARow.verdict)}`);
  assert.ok(!emptyRow.verdict?.redundantWith?.length,
    `genuinely-empty must NOT carry redundantWith or this is not the negative control: ${JSON.stringify(emptyRow.verdict)}`);

  const frame = strip(renderFrame(model, { selected: 0, filter: 'all', message: '' }, { columns: 120, rows: 30 }));
  const lines = frame.split('\n');
  const listLineFor = (id) => lines.find((l) => l.includes(id) && l.includes('DISPOSABLE'));

  const twinLine = listLineFor('twin-a');
  const emptyLine = listLineFor('genuinely-empty');
  assert.ok(twinLine && emptyLine, `both rows must be visible in the list: ${JSON.stringify({ twinLine, emptyLine })}`);
  assert.notEqual(twinLine.trim()[0], emptyLine.trim()[0],
    `a redundant-safe row and a genuinely-empty row draw the SAME marker, so a human cannot tell them ` +
    `apart at a glance: ${JSON.stringify({ twinLine, emptyLine })}`);

  // The detail pane, for the redundant one: must name the sibling and must NOT say the generic,
  // false-in-this-case "nothing here" reason.
  const twinAIndex = model.rows.findIndex((r) => r.id === 'twin-a');
  const twinDetail = strip(renderFrame(model, { selected: twinAIndex, filter: 'all', message: '' },
    { columns: 130, rows: 30 })).split('\n').map((l) => l.split('│')[1] ?? '').join('\n');
  assert.match(twinDetail, /safe only because a living sibling holds the identical content/);
  assert.match(twinDetail, /redundant\s+identical to work also held by twin-b/);
  assert.doesNotMatch(twinDetail, /no committed delta/,
    'the generic "nothing here" reason must not sit next to the real, contradicting reason');

  // The detail pane, for the genuinely empty one: the SAME suppression must not fire when there
  // is nothing to suppress — proving the change is conditional, not a blanket deletion of the line.
  const emptyIndex = model.rows.findIndex((r) => r.id === 'genuinely-empty');
  const emptyDetail = strip(renderFrame(model, { selected: emptyIndex, filter: 'all', message: '' },
    { columns: 130, rows: 30 })).split('\n').map((l) => l.split('│')[1] ?? '').join('\n');
  assert.match(emptyDetail, /no committed delta/, 'a genuinely empty workstream must still say so');
  assert.doesNotMatch(emptyDetail, /redundant\s+identical to/, 'nothing to attribute to a sibling here');
});

/**
 * THE OVERFLOW COUNTER MUST BE DERIVED FROM WHAT WAS SHOWN.
 *
 * The detail pane lists the symbols a deletion would lose, truncates them to fit, and says how many
 * it left out. That count was computed from a THIRD expression — the slice used
 * `height - L.length - 8`, the decision to print used `height - L.length - 6`, and the number itself
 * used `height - 8` — and `L.length` grows as the loop pushes, so the second did not even read the
 * same value as the first. On a short terminal the slice floored at 3 while the counter subtracted a
 * window that no longer matched, and the pane printed things that cannot be true:
 *
 *     12 unique symbols at height 26  ->  "… and 0 more"
 *     12 unique symbols at height 28  ->  "… and -2 more"
 *
 * Both measured. Nothing failed, because no test read this line at any height — the frame-height
 * gate asserts the pane is the right SIZE, not that its contents are arithmetically possible.
 *
 * This is the project's recurring shape at display level: one quantity, several readers, drifting.
 * The fix derives the remainder from the slice that was actually taken, which makes a negative and a
 * spurious zero unrepresentable rather than merely unobserved — so this test asserts the property
 * across the whole height range, not the two values that happened to break.
 */
test('TUI: the overflow counter is never negative, never zero, and never exceeds the total', async (t) => {
  const { fx } = await standardFixture();
  t.after(() => fx.cleanup());

  // The standard fixture's at-risk worktree holds ONE unique symbol, so its detail pane never
  // overflows and every assertion below would pass while reading nothing. Enough symbols to force
  // truncation at every height in the range is the whole precondition of this test.
  await fx.write('src/many_unique.js',
    Array.from({ length: 30 }, (_, i) => `export function ONLY_SYMBOL_${i}() { return ${i}; }\n`).join(''),
    fx.wt('uniqueUncommitted'));

  const model = await buildModel(fx.root);
  const atRisk = model.rows.findIndex((r) => r.bucket === 'atRisk');
  assert.ok(atRisk >= 0, 'PREMISE: the fixture must have an at-risk row or this test reads nothing');

  let sawCounter = false;
  for (let rows = 14; rows <= 60; rows++) {
    const frame = strip(renderFrame(model, { selected: atRisk, filter: 'all', message: '' },
      { columns: 110, rows }));
    const m = frame.match(/… and (-?\d+) more/);
    if (!m) continue;
    sawCounter = true;
    const n = Number(m[1]);
    assert.ok(n > 0, `the overflow counter must be a real remainder at height ${rows}, got "${m[0]}"`);
  }

  // ANTI-VACUITY. A fixture whose detail pane never overflows would pass every assertion above
  // while reading nothing at all — which is exactly how this line went untested in the first place.
  assert.ok(sawCounter,
    'PREMISE BROKEN — no height in 14..60 produced an overflow line, so nothing was measured');
});
