// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Explicit repository-local authority for the branch/ref work is actually landed into.
 *
 * This deliberately lives in the shared Git common directory, not `.holtrc.json`: a branch may
 * modify tracked configuration as part of the very proposal Holt is judging. Setting this value
 * is a separate local action and every linked worktree reads the same private, stable record.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { git, resolveRef } from './git.mjs';
import { readStableRegularFile, writePrivateFileAtomic } from './stable-file.mjs';

const VERSION = 1;
const MAX_BYTES = 16 * 1024;

function validateRef(ref) {
  const value = String(ref ?? '');
  if (!value || value.length > 1024 || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error('integration base must be a non-empty ref without control characters');
  }
  return value;
}

async function statePath(cwd) {
  const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  const common = r.code === 0 ? r.stdout.trim() : '';
  if (!common || !path.isAbsolute(common)) {
    throw new Error('could not locate the repository Git common directory');
  }
  return path.join(common, 'holt-integration-base', 'base.json');
}

export async function readIntegrationBase(cwd) {
  const file = await statePath(cwd);
  const stable = await readStableRegularFile(file, {
    maxBytes: MAX_BYTES, requireOwner: true, requireSingleLink: true,
  });
  if (!stable.ok) {
    if (stable.reason === 'open-failed' && stable.code === 'ENOENT') return null;
    throw new Error(`configured integration base is unavailable (${stable.reason})`);
  }
  let record;
  try { record = JSON.parse(stable.bytes.toString('utf8')); } catch {
    throw new Error('configured integration base is not valid JSON');
  }
  if (!record || record.version !== VERSION || record.kind !== 'holt-integration-base') {
    throw new Error('configured integration base has an unsupported format');
  }
  return { ref: validateRef(record.ref), updatedAt: record.updatedAt ?? null, file };
}

export async function setIntegrationBase(cwd, ref) {
  const value = validateRef(ref);
  const oid = await resolveRef(cwd, value);
  if (!oid) throw new Error(`integration base '${value}' does not resolve`);
  const file = await statePath(cwd);
  await writePrivateFileAtomic(file, Buffer.from(`${JSON.stringify({
    version: VERSION,
    kind: 'holt-integration-base',
    ref: value,
    updatedAt: new Date().toISOString(),
  })}\n`, 'utf8'));
  return { ref: value, oid, file };
}

export async function clearIntegrationBase(cwd) {
  const file = await statePath(cwd);
  const previous = await readIntegrationBase(cwd);
  if (!previous) return { removed: false, ref: null, file };
  await fs.rm(file, { force: false });
  await fs.rmdir(path.dirname(file)).catch(() => {});
  return { removed: true, ref: previous.ref, file };
}
