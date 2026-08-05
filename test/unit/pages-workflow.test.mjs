// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Keep the Pages deployment inside the repository's full-SHA action policy.
 * GitHub's upstream upload-pages-artifact composite currently calls upload-artifact by tag;
 * the checked-in wrapper is intentional and must not silently drift back to that form.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Pages deployment pins its nested artifact action', async () => {
  const workflow = await fs.readFile(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8');
  const action = await fs.readFile(path.join(ROOT, '.github/actions/upload-pages-artifact/action.yml'), 'utf8');
  assert.match(workflow, /uses:\s+\.\/\.github\/actions\/upload-pages-artifact/);
  assert.match(action, /uses:\s+actions\/upload-artifact@[0-9a-f]{40}\s+#\s+v4\.6\.2/);
  assert.doesNotMatch(action, /actions\/upload-artifact@v4(?:\s|$)/,
    'the nested artifact upload must remain pinned under repository policy');
});
