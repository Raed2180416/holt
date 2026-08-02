#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — run THE GUARD CORPUS, explicitly, by name, on this platform.
 *
 * WHY THIS EXISTS RATHER THAN A GLOB. `npm test` is `node --test "test/** /*.test.mjs"`, and a
 * glob that matches nothing is not an error:
 *
 *     $ node --test "test/nonexistent/** /*.test.mjs" ; echo $?
 *     ℹ tests 0
 *     ℹ pass 0
 *     0
 *
 * Reproduced on this machine, node 22. So a green `npm test` proves the runner started; it does
 * not prove that any named file ran. The guard corpus — the suites that decide whether holt lets
 * an agent destroy work — reached Windows and macOS solely through that glob. This runner names
 * every file, checks each one exists BEFORE running anything, and refuses to report success on an
 * empty or partial corpus. Absence of a file is a failure, never a silent pass.
 *
 * Usage:
 *   node scripts/run-guard-corpus.mjs            # run the corpus
 *   node scripts/run-guard-corpus.mjs --list     # print the resolved file list and exit
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = path.join(ROOT, '.github', 'guard-corpus.txt');

/**
 * Parse the manifest into repository-relative POSIX paths.
 *
 * The entries stay in forward-slash space and are handed to `node --test` unchanged. node accepts
 * forward slashes on Windows; converting to `path.sep` here would be the exact class of bug this
 * corpus exists to catch (string surgery on a native path).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseManifest(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/**
 * Read the manifest and prove every entry is a real, non-empty file.
 *
 * @param {string} [manifestPath]
 * @returns {Promise<{ files: string[], problems: string[] }>}
 */
export async function resolveCorpus(manifestPath = MANIFEST) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string} */
  let text;
  try {
    text = await fs.readFile(manifestPath, 'utf8');
  } catch (e) {
    return { files: [], problems: [`the guard-corpus manifest is unreadable: ${manifestPath} (${/** @type {Error} */ (e).message})`] };
  }
  const files = parseManifest(text);
  // AN EMPTY CORPUS MUST NOT BE A PASS. `node --test` with no files, like `node --test` with a
  // glob that matches nothing, exits 0 — which would turn "somebody emptied the manifest" into a
  // green build on all three operating systems.
  if (files.length === 0) problems.push(`the guard-corpus manifest names no files: ${manifestPath}`);
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f)) problems.push(`duplicate entry in the guard-corpus manifest: ${f}`);
    seen.add(f);
    if (path.posix.isAbsolute(f) || /^[A-Za-z]:/.test(f) || f.includes('\\')) {
      problems.push(`guard-corpus entries must be repository-relative POSIX paths, got: ${f}`);
      continue;
    }
    const abs = path.join(ROOT, f);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) problems.push(`guard-corpus entry is not a file: ${f}`);
      else if (st.size === 0) problems.push(`guard-corpus entry is an empty file (it would run zero tests): ${f}`);
    } catch {
      problems.push(`guard-corpus entry does not exist: ${f}`);
    }
  }
  return { files, problems };
}

/* c8 ignore start — CLI wrapper; the logic above is what check-ci-hardening.mjs --self-test drives */
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('run-guard-corpus.mjs')) {
  const { files, problems } = await resolveCorpus();
  if (problems.length) {
    for (const p of problems) console.error(`::error::guard corpus: ${p}`);
    process.exit(1);
  }
  if (process.argv.includes('--list')) {
    for (const f of files) console.log(f);
    process.exit(0);
  }
  console.log(`guard corpus on ${process.platform}/${process.arch}: ${files.length} files, named explicitly`);
  for (const f of files) console.log(`  ${f}`);
  const child = spawn(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`::error::guard corpus was killed by ${signal} — that is a failure, not a skip`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
  child.on('error', (e) => {
    console.error(`::error::guard corpus could not be started: ${e.message}`);
    process.exit(1);
  });
}
/* c8 ignore stop */
