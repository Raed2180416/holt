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
 *   - LOUD ON ERROR — BUT NEVER LETHAL. A file that exists but fails to parse, isn't a JSON
 *     object, or has a key of the wrong shape throws `ConfigError` — it is never silently
 *     ignored. A user who believes their config is active is owed the truth if it is not.
 *     BUT: an unknown key is a WARNING, not an error — a user who adds `$schema` or a future
 *     key holt doesn't know about yet must not have their guard killed by it. And a ConfigError
 *     must NEVER kill the hook/gate/rescue/doctor commands — those are safety-critical and must
 *     fall back to defaults with a warning rather than leaving the agent unprotected.
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


/**
 * Does this pattern contain a NESTED QUANTIFIER — the shape that makes a regex hang?
 *
 * REPRODUCED: a `.holtrc.json` containing `{"familyOverrides": ["^(a+)+$"]}` and a worktree named
 * `aaaa…aaaX` made `holt status` hang indefinitely. Every command that reads config hangs the same
 * way, INCLUDING the blocking PreToolUse guard — which means an agent frozen forever, by a config
 * file a teammate committed. `inferFamily` already wraps the match in try/catch, and a catch does
 * not help: catastrophic backtracking is not an exception, it is an unbounded loop inside a single
 * atomic `String.match` call that nothing in JavaScript can interrupt.
 *
 * There is no way to time-bound a native RegExp, so the pattern is refused BEFORE it is ever run.
 * The check is the well-known low-false-positive one: a group that is itself quantified and whose
 * body already contains a quantifier — `(a+)+`, `(x*)*`, `([a-z]+)*`, `(\d{2,}){3,}`. Ordinary
 * grouping is untouched: `(abc)+`, `(a|b)+` and `(\d+)` all have exactly one of the two halves.
 *
 * A rejected pattern is a WARNING, not a refusal of the whole product — the surrounding config
 * gate's rule. holt says which pattern it declined and why, and carries on with the rest.
 */
export function hasNestedQuantifier(source) {
  const src = String(source);
  // A group whose CONTENT ends in a quantifier and which is ITSELF quantified.
  return /\((?:\?[:=!]|\?<[=!a-zA-Z])?(?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})\s*\)\s*(?:[+*]|\{\d+,\d*\})/.test(src);
}

const KNOWN_KEYS = ['familyOverrides', 'guardAllow', 'maintenanceFloor', 'maintenanceRatio'];

// Keys that are silently ignored — they are standard JSON config metadata, not holt settings.
// `$schema` is the JSON Schema standard self-reference key; any editor that supports JSON
// schemas will add it automatically, and killing the guard on it would be a self-inflicted
// wound.
const IGNORED_KEYS = ['$schema'];

export class ConfigError extends Error {
  constructor(message, filePath) {
    super(message);
    this.name = 'ConfigError';
    this.path = filePath;
  }
}

/** A warning about an unknown key — non-fatal, but surfaced to the user. */
export class ConfigWarning {
  constructor(message, filePath) {
    this.message = message;
    this.path = filePath;
  }
}

/** Validate a parsed config object. Throws ConfigError on structural errors; warns on unknown keys. */
function validate(raw, filePath) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${filePath}: top-level value must be a JSON object`, filePath);
  }

  const warnings = [];
  for (const key of Object.keys(raw)) {
    if (IGNORED_KEYS.includes(key)) continue;
    if (!KNOWN_KEYS.includes(key)) {
      // Unknown keys WARN, they do not kill. A user who adds a future key or `$schema` must not
      // have their guard die. The warning is still loud — printed to stderr — so the user knows
      // their config is not fully in effect.
      warnings.push(new ConfigWarning(
        `${filePath}: unknown key "${key}" (known keys: ${KNOWN_KEYS.join(', ')}) — ignored`,
        filePath,
      ));
    }
  }

  const out = {};

  if ('familyOverrides' in raw) {
    const v = raw.familyOverrides;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new ConfigError(`${filePath}: "familyOverrides" must be an array of regex strings`, filePath);
    }
    const safe = [];
    for (const pattern of v) {
      try { new RegExp(pattern); } catch (e) {
        throw new ConfigError(
          `${filePath}: "familyOverrides" entry ${JSON.stringify(pattern)} is not a valid regular expression (${e.message})`,
          filePath,
        );
      }
      // A pattern that can hang is DECLINED, loudly, and the rest still apply. Killing the whole
      // product over one bad entry is the failure mode the config gate exists to avoid; running it
      // anyway freezes the agent forever. See hasNestedQuantifier.
      if (hasNestedQuantifier(pattern)) {
        process.stderr.write(
          `holt: ignoring "familyOverrides" entry ${JSON.stringify(pattern)} — it contains a nested `
          + 'quantifier, which can make a regular expression run without bound and would hang every '
          + `holt command including the guard. Rewrite it without the nesting (${filePath}).\n`,
        );
        continue;
      }
      safe.push(pattern);
    }
    out.familyOverrides = safe;
  }

  if ('guardAllow' in raw) {
    const v = raw.guardAllow;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new ConfigError(`${filePath}: "guardAllow" must be an array of regex strings`, filePath);
    }
    const safe = [];
    for (const pattern of v) {
      try { new RegExp(pattern); } catch (e) {
        throw new ConfigError(
          `${filePath}: "guardAllow" entry ${JSON.stringify(pattern)} is not a valid regular expression (${e.message})`,
          filePath,
        );
      }
      if (hasNestedQuantifier(pattern)) {
        process.stderr.write(
          `holt: ignoring "guardAllow" entry ${JSON.stringify(pattern)} — it contains a nested `
          + 'quantifier and would make the guard run without bound.\n',
        );
        continue;
      }
      safe.push(pattern);
    }
    out.guardAllow = safe;
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

  return { config: out, warnings };
}

/**
 * Load `.holtrc.json` from the main worktree root, if present.
 *
 * @param {string} cwd  any path inside the repository
 * @returns {Promise<{found: boolean, path: string|null, config: object, warnings: ConfigWarning[]}>}
 * @throws {ConfigError} when the file exists but is structurally invalid (not JSON, not an
 *   object, wrong-type key). Unknown keys produce warnings, not errors.
 */
export function guardAllowPattern(command, patterns = []) {
  if (typeof command !== 'string') return null;
  for (const source of patterns) {
    try {
      if (new RegExp(source).test(command)) return source;
    } catch { return null; }
  }
  return null;
}

export async function loadConfig(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return { found: false, path: null, config: {}, warnings: [] };

  const filePath = path.join(root, CONFIG_FILENAME);
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { found: false, path: null, config: {}, warnings: [] };
    throw new ConfigError(`${filePath}: could not be read (${e.message})`, filePath);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`${filePath}: invalid JSON (${e.message})`, filePath);
  }

  const { config, warnings } = validate(parsed, filePath);
  return { found: true, path: filePath, config, warnings };
}
