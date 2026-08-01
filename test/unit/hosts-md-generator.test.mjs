// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — HOSTS.md must be exactly what scripts/generate-hosts.mjs produces from the manifest.
 *
 * HOSTS.md used to be hand-synced from src/integrate/hosts.mjs and nothing checked that the two
 * agreed. It drifted at least twice: Cursor's promotion to a docs-verified block hook went
 * unreflected, and the Roo/Kilo split (two products, two config formats) showed up as one stale
 * row. This test is the gate `npm run hosts:check` runs in CI, proven here on the filesystem
 * rather than trusted from a script's exit code.
 */

import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTS } from '../../src/integrate/hosts.mjs';
import {
  regenerate,
  renderHostsTable,
  replaceBetweenMarkers,
  HOSTS_MD_PATH,
  TABLE_BEGIN,
  TABLE_END,
  CAVEAT_BEGIN,
} from '../../scripts/generate-hosts.mjs';

test('HOSTS.md: the checked-in file is byte-identical to what the generator produces', async () => {
  const committed = await fs.readFile(HOSTS_MD_PATH, 'utf8');
  const regenerated = regenerate(committed, HOSTS);

  // Regenerate into an actual temp directory and read it back — proof from the filesystem, not
  // from comparing two in-memory strings the same function happened to build.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-hosts-md-'));
  try {
    const tmpFile = path.join(dir, 'HOSTS.md');
    await fs.writeFile(tmpFile, regenerated, 'utf8');
    const roundTripped = await fs.readFile(tmpFile, 'utf8');

    assert.equal(roundTripped, committed,
      'HOSTS.md is stale — it does not match what `npm run hosts:generate` produces from '
      + 'src/integrate/hosts.mjs. Run `npm run hosts:generate` and commit the result.');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('HOSTS.md generator: anti-vacuity — a real manifest change is actually caught', async () => {
  // PROVE PRESENCE BEFORE TRUSTING SILENCE. The test above passing could mean "in sync" or could
  // mean "the comparison never fires" (a marker silently not found, a body always considered
  // equal, etc). Mutate the manifest in memory and confirm the generated output actually changes
  // and actually disagrees with the committed file — so the byte-identical assertion above is
  // known to be capable of failing, not vacuously green.
  const committed = await fs.readFile(HOSTS_MD_PATH, 'utf8');
  const mutated = HOSTS.map((h, i) => (i === 0 ? { ...h, name: `${h.name} (MUTATED FOR TEST)` } : h));
  const regeneratedFromMutant = regenerate(committed, mutated);

  assert.notEqual(regeneratedFromMutant, committed,
    'changing a host name in the manifest must change the generated HOSTS.md — if it does not, '
    + 'the drift check above cannot actually detect drift');
  assert.ok(regeneratedFromMutant.includes('(MUTATED FOR TEST)'), 'the mutated name must reach the rendered table');
});

test('HOSTS.md generator: every host in the manifest appears in the generated table', () => {
  const table = renderHostsTable(HOSTS);
  assert.ok(HOSTS.length >= 10, 'sanity: the manifest looks empty — this test would pass vacuously');
  for (const h of HOSTS) {
    assert.ok(table.includes(h.name), `generated table is missing host ${h.id} (${h.name})`);
  }
});

test('HOSTS.md generator: refuses to run rather than silently no-op if a marker is hand-deleted', async () => {
  const committed = await fs.readFile(HOSTS_MD_PATH, 'utf8');
  const withoutTableMarker = committed.replace(TABLE_BEGIN, '');
  assert.throws(() => regenerate(withoutTableMarker, HOSTS), /begin marker not found/,
    'deleting the table BEGIN marker must throw, not silently leave the stale table in place');

  const withoutCaveatMarker = committed.replace(CAVEAT_BEGIN, '');
  assert.throws(() => regenerate(withoutCaveatMarker, HOSTS), /begin marker not found/);
});

test('replaceBetweenMarkers: rejects a duplicated marker rather than picking one silently', () => {
  const text = `a\n${TABLE_BEGIN}\nold\n${TABLE_END}\nb\n${TABLE_BEGIN}\nold2\n${TABLE_END}\n`;
  assert.throws(() => replaceBetweenMarkers(text, TABLE_BEGIN, TABLE_END, 'new'), /more than once/);
});

test('HOSTS.md: the hand-authored "Reading this table" section survives regeneration untouched', async () => {
  // The whole point of the marker scheme is that generated and authored content coexist. Prove
  // the authored section is not merely present but IDENTICAL before and after a regeneration pass.
  const committed = await fs.readFile(HOSTS_MD_PATH, 'utf8');
  const heading = '## Reading this table';
  const before = committed.slice(committed.indexOf(heading));
  assert.ok(before.length > 40, 'the hand-authored section could not be located');

  const regenerated = regenerate(committed, HOSTS);
  const after = regenerated.slice(regenerated.indexOf(heading));
  assert.equal(after, before, 'regenerating must not touch the hand-authored prose outside the markers');
});
