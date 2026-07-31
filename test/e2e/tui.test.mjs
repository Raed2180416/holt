/**
 * grove — the TUI, tested through its snapshot path.
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
import { standardFixture } from '../fixtures.mjs';
import { buildModel, renderFrame } from '../../src/tui.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'grove.mjs');
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
  assert.match(frame, /grove rescue uniqueUncommitted --release/,
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
  assert.match(text, /grove/, 'header present');
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
