// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — project configuration file.
 *
 * `inferFamily` has always taken `familyOverrides`, and `MAINTENANCE_FLOOR` /
 * `MAINTENANCE_RATIO` were exported "so a future config surface has one place to override" —
 * but until this file, nothing let a user actually supply either one. That made
 * `familyOverrides` a documented capability with no way to reach it: a phantom feature.
 *
 * THE DESIGN, deliberately narrow:
 *
 *   - OPTIONAL. No file, `.holtrc.json` absent -> defaults, silently. The overwhelming majority
 *     of repositories will never have one, and that must never be treated as a problem.
 *
 *   - PROJECT-SCOPED. Read from the MAIN worktree root (via repoRoot()), never a linked
 *     worktree and never a user-global path — holt already promises `integrate` touches nothing
 *     outside the repo without `--global`; config follows the same rule.
 *
 *   - LOUD ON ERROR. A file that exists but fails to parse, isn't a JSON object, has an unknown
 *     key, or has a key of the wrong shape throws `ConfigError` — it is never silently ignored.
 *     A user who believes their config is active is owed the truth if it is not.
 *
 *   - CANNOT MAKE HOLT LESS SAFE. Every key here tunes a HEURISTIC (name-based family grouping,
 *     the maintenance-nag threshold) — never the content-identity safety contract in analyze.mjs
 *     that decides what "unique work" and "safe to delete" mean. See inferFamily()'s existing
 *     `rule: 'user-override'` handling in discover.mjs / analyze.mjs: a user-declared family
 *     grouping was already trusted more directly than a heuristic guess before this file existed
 *     (an override is exact evidence; a regex match on a generated name is not) — this file only
 *     makes that existing, already-reviewed knob reachable from disk instead of from a caller
 *     nothing could actually be.  It cannot mark anything "safe" that content-identity doesn't.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './git.mjs';

export const CONFIG_FILENAME = '.holtrc.json';

const KNOWN_KEYS = ['familyOverrides', 'maintenanceFloor', 'maintenanceRatio'];

export class ConfigError extends Error {
  constructor(message, filePath) {
    super(message);
    this.name = 'ConfigError';
    this.path = filePath;
  }
}

/** Validate a parsed config object. Throws ConfigError on anything outside the documented schema. */
function validate(raw, filePath) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${filePath}: top-level value must be a JSON object`, filePath);
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) {
      throw new ConfigError(
        `${filePath}: unknown key "${key}" (known keys: ${KNOWN_KEYS.join(', ')})`, filePath,
      );
    }
  }

  const out = {};

  if ('familyOverrides' in raw) {
    const v = raw.familyOverrides;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new ConfigError(`${filePath}: "familyOverrides" must be an array of regex strings`, filePath);
    }
    for (const pattern of v) {
      try { new RegExp(pattern); } catch (e) {
        throw new ConfigError(
          `${filePath}: "familyOverrides" entry ${JSON.stringify(pattern)} is not a valid regular expression (${e.message})`,
          filePath,
        );
      }
    }
    out.familyOverrides = v;
  }

  if ('maintenanceFloor' in raw) {
    const v = raw.maintenanceFloor;
    if (!Number.isInteger(v) || v < 0) {
      throw new ConfigError(`${filePath}: "maintenanceFloor" must be a non-negative integer`, filePath);
    }
    out.maintenanceFloor = v;
  }

  if ('maintenanceRatio' in raw) {
    const v = raw.maintenanceRatio;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new ConfigError(`${filePath}: "maintenanceRatio" must be a number between 0 and 1`, filePath);
    }
    out.maintenanceRatio = v;
  }

  return out;
}

/**
 * Load `.holtrc.json` from the main worktree root, if present.
 *
 * @param {string} cwd  any path inside the repository
 * @returns {Promise<{found: boolean, path: string|null, config: object}>}
 * @throws {ConfigError} when the file exists but is invalid — never swallowed.
 */
export async function loadConfig(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return { found: false, path: null, config: {} };

  const filePath = path.join(root, CONFIG_FILENAME);
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { found: false, path: null, config: {} };
    throw new ConfigError(`${filePath}: could not be read (${e.message})`, filePath);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`${filePath}: invalid JSON (${e.message})`, filePath);
  }

  return { found: true, path: filePath, config: validate(parsed, filePath) };
}
