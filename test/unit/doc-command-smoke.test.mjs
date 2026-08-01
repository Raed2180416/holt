// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — every `holt ...` invocation shown in the documentation must be a command the CLI
 * actually has, using flags the CLI actually parses.
 *
 * WHY THIS EXISTS. Every doc in this repository shows `holt` commands as proof the tool does
 * what the prose claims. Nothing ever checked that those commands still exist: a rename, a
 * removed flag, or a typo in copy ships silently, and the first person to notice is a user
 * running the README's own examples. That happened repeatedly the night this test was written —
 * `holt discard` was documented as the fix for a refusal before the command existed; a release
 * tarball shipped without the module a documented command needed.
 *
 * WHAT THIS IS, AND ISN'T. A smoke gate, not a full execution harness: it does not run a single
 * `holt` command, so it cannot catch a command that parses but behaves wrong (that is what the
 * rest of the suite is for). It catches the class of defect where the doc and the CLI have
 * silently drifted apart — a command name that no longer exists, a flag that was renamed or
 * removed, an `npm run` script nobody wired up. That class recurs with every rename because
 * nothing re-derives the doc from the code; this test re-derives the CHECK from the code instead
 * of hand-maintaining a second list that would rot exactly like the docs did.
 *
 * HOW COMMANDS AND FLAGS ARE DERIVED. Not hand-copied here — regexed live out of bin/holt.mjs's
 * own dispatch (`if (cmd === '...')`, `case '...':` in the command switch) and its own option
 * parser (`case '--...':` / `case '-x':` in parseArgs). If a command or flag is renamed in the
 * CLI, the set this test checks against renames itself in the same commit; only a doc that still
 * mentions the OLD name can fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_SOURCE = path.join(ROOT, 'bin', 'holt.mjs');

/* --------------------------------------------------- derive the CLI's own command/flag sets ---- */

/**
 * Every subcommand bin/holt.mjs actually dispatches on, read out of its own source rather than
 * hand-copied: the early `cmd === 'x'` guards (mcp, doctor, hook, tui, order, partition,
 * branches, license, fleet, ci, journal, auto, protect, unprotect, rescued, discard, clean,
 * verify, rescue, brief, hosts, setup, integrate, help, version) plus the trailing
 * `switch (cmd) { case 'x': ... }` (status, scan, risk, collisions, duplicates, plan, impact,
 * graph, context, gate). A command renamed or removed in the CLI changes this set in the same
 * commit that changed the CLI — the alternative, a list maintained by hand in a test file, is
 * exactly the kind of doc-shaped drift this file exists to stop.
 */
function deriveCommands(src) {
  const commands = new Set();
  for (const m of src.matchAll(/\bcmd\s*===\s*'([a-z][a-z-]*)'/g)) commands.add(m[1]);
  for (const m of src.matchAll(/case\s+'([a-z][a-z-]*)':/g)) commands.add(m[1]);
  return commands;
}

/**
 * Every `--flag` (and short `-x` alias) parseArgs actually recognises, read the same way. A flag
 * documented but never wired (or renamed — `--dry-run` becoming `--dryrun`) shows up as an
 * unrecognised flag in whichever doc still spells it the old way.
 */
function deriveFlags(src) {
  const flags = new Set();
  for (const m of src.matchAll(/case\s+'(--[a-zA-Z][a-zA-Z-]*)':/g)) flags.add(m[1]);
  for (const m of src.matchAll(/case\s+'(-[a-zA-Z])':/g)) flags.add(m[1]);
  return flags;
}

/* --------------------------------------------------------------- extracting doc commands ---- */

/** Markdown files this repository ships or maintains. Walked fresh each run — a new doc under
 * these roots is covered automatically, nothing to register by hand. */
async function markdownFiles() {
  const files = [];
  const rootEntries = await fs.readdir(ROOT, { withFileTypes: true });
  for (const e of rootEntries) {
    if (e.isFile() && e.name.endsWith('.md')) {
      // HANDOFF.md is gitignored operator scratch (session forensics, workflow resume calls,
      // key-generation one-liners) — not shipped documentation, and its shell fragments were
      // never meant to be `holt` invocations that stay working. It may not even exist in a
      // clean checkout.
      if (e.name === 'HANDOFF.md') continue;
      files.push(path.join(ROOT, e.name));
    }
  }
  for (const dir of ['docs', '.github/releases', 'legal']) {
    const abs = path.join(ROOT, dir);
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isFile() && e.name.endsWith('.md')) files.push(path.join(abs, e.name));
  }
  return files;
}

/**
 * Fenced code blocks (any language tag, or none) plus inline single-backtick spans. These are
 * the two places a doc shows a command as something to actually run, as opposed to naming it in
 * plain prose ("holt is not on the npm registry yet" must never be parsed as a command called
 * `is`) — restricting extraction to code contexts is what keeps that distinction intact.
 */
function extractCodeSpans(text) {
  const spans = [];
  const lines = text.split('\n');
  let inFence = false;
  let fenceBuf = [];
  let fenceStartLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^```(\w*)\s*$/.exec(line.trim());
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceBuf = [];
        fenceStartLine = i + 1;
      } else {
        inFence = false;
        spans.push({ text: fenceBuf.join('\n'), line: fenceStartLine });
      }
      continue;
    }
    if (inFence) fenceBuf.push(line);
  }
  // Inline `code` spans, line by line so a failure can be pointed at a line number.
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/`([^`\n]+)`/g)) spans.push({ text: m[1], line: i + 1 });
  }
  return spans;
}

/** Strip a trailing unquoted `# comment` and a leading shell prompt marker. */
function stripPromptAndComment(fragment) {
  let s = fragment.replace(/^\s*[$>]\s*/, '');
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) s = s.slice(0, hashIdx);
  return s.trim();
}

/** Very small whitespace tokenizer — every example here is simple enough not to need real shell
 * quoting rules, and a token this misreads is a token that would also confuse a human reader. */
function tokenize(fragment) {
  return fragment.split(/\s+/).filter(Boolean).map((t) => t.replace(/^[[(]+|[\])]+$/g, ''));
}

/** Split one logical line into separate commands on unquoted shell separators. */
function splitCommands(line) {
  return line.split(/&&|\|\||[;|]/);
}

/**
 * Pull every `holt <subcommand> ...` invocation out of a block of text (a fenced block or an
 * inline span). Requires whitespace directly after `holt` — `holt's`, `holt-armed`, `holt_clean`
 * (an MCP tool name, not a CLI invocation) and `holt:` (an error-message prefix in example output)
 * all fail that test on purpose, so prose mentioning holt in passing is never misread as a command.
 */
function findHoltInvocations(text) {
  const found = [];
  for (const rawLine of text.split('\n')) {
    for (const segment of splitCommands(rawLine)) {
      const cleaned = stripPromptAndComment(segment);
      if (!/^holt\s+\S/.test(cleaned)) continue;
      found.push(cleaned);
    }
  }
  return found;
}

/** Pull every `npm run <script>` reference — checked against package.json's own scripts. */
function findNpmRunScripts(text) {
  const found = [];
  for (const m of text.matchAll(/\bnpm\s+run\s+([a-zA-Z0-9:_-]+)/g)) found.push(m[1]);
  return found;
}

/* ------------------------------------------------------------------------------- the test ---- */

test('DOC SMOKE: every `holt ...` command shown in the docs is a real command with real flags', async () => {
  const src = await fs.readFile(CLI_SOURCE, 'utf8');
  const commands = deriveCommands(src);
  const flags = deriveFlags(src);

  // Anti-vacuity: if this ever comes back near-empty, the regex has drifted from bin/holt.mjs's
  // own shape (a refactor to a Map, a different case-statement style) and the test would pass by
  // checking nothing. The CLI has 30+ subcommands and 20+ flags; demand most of them.
  assert.ok(commands.size >= 25,
    `only ${commands.size} commands derived from bin/holt.mjs — extraction has drifted from the CLI's shape`);
  assert.ok(flags.size >= 15,
    `only ${flags.size} flags derived from bin/holt.mjs — extraction has drifted from the CLI's shape`);

  const files = await markdownFiles();
  assert.ok(files.length >= 8, `only found ${files.length} markdown files to check — glob has drifted`);

  const failures = [];
  let invocationsChecked = 0;
  let npmScriptsChecked = 0;
  let pkgScripts = null;

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const text = await fs.readFile(file, 'utf8');
    const spans = extractCodeSpans(text);

    for (const { text: spanText, line } of spans) {
      for (const invocation of findHoltInvocations(spanText)) {
        invocationsChecked++;
        const tokens = tokenize(invocation);
        const [, sub, ...rest] = tokens;
        if (!sub) continue; // bare "holt" with nothing after it, already filtered by the regex

        if (!commands.has(sub) && !['help', 'version'].includes(sub)) {
          failures.push(`${rel}:${line}: \`${invocation}\` — '${sub}' is not a command bin/holt.mjs dispatches on`);
          continue;
        }
        for (const tok of rest) {
          if (tok.startsWith('--') && !flags.has(tok)) {
            failures.push(`${rel}:${line}: \`${invocation}\` — flag '${tok}' is not recognised by parseArgs`);
          } else if (/^-[a-zA-Z]$/.test(tok) && !flags.has(tok)) {
            failures.push(`${rel}:${line}: \`${invocation}\` — flag '${tok}' is not recognised by parseArgs`);
          }
        }
      }

      for (const script of findNpmRunScripts(spanText)) {
        npmScriptsChecked++;
        if (!pkgScripts) {
          const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
          pkgScripts = pkg.scripts ?? {};
        }
        if (!(script in pkgScripts)) {
          failures.push(`${rel}:${line}: \`npm run ${script}\` — no such script in package.json`);
        }
      }
    }
  }

  assert.ok(invocationsChecked >= 20,
    `only ${invocationsChecked} \`holt ...\` invocations found across ${files.length} docs — ` +
    'extraction has drifted from how the docs write commands (fewer checks than before is a red flag, not a clean run)');

  assert.equal(failures.length, 0, `doc/CLI drift found:\n  ${failures.join('\n  ')}`);
});

test('DOC SMOKE: the command/flag extraction can actually fail — proven against a planted mismatch', async () => {
  // The test above is only as good as its ability to fail. Prove it fires on both defect
  // classes it exists to catch, using synthetic CLI source and doc text so this needs no
  // planted file in the real tree.
  const fakeSrc = `
    if (cmd === 'status') {}
    switch (cmd) {
      case 'risk':
      case 'collisions':
    }
    switch (a) {
      case '--json': break;
      case '--cwd': break;
      case '-h': break;
    }
  `;
  const commands = deriveCommands(fakeSrc);
  const flags = deriveFlags(fakeSrc);

  assert.ok(commands.has('status') && commands.has('risk') && commands.has('collisions'));
  assert.ok(flags.has('--json') && flags.has('--cwd') && flags.has('-h'));

  // A renamed/removed command: doc says `holt discard`, CLI (in this synthetic source) has none.
  const removedCommandDoc = '```bash\nholt discard ./scratch\n```';
  const invocations = findHoltInvocations(extractCodeSpans(removedCommandDoc)[0].text);
  assert.equal(invocations.length, 1);
  const [, sub] = tokenize(invocations[0]);
  assert.equal(commands.has(sub), false, 'the planted removed-command case must be a miss, proving the check can fail');

  // A renamed/removed flag: doc says `--force`, CLI (in this synthetic source) has no such flag.
  const removedFlagDoc = '`holt status --force`';
  const inv2 = findHoltInvocations(extractCodeSpans(removedFlagDoc)[0].text)[0];
  const rest = tokenize(inv2).slice(2);
  assert.ok(rest.includes('--force'));
  assert.equal(flags.has('--force'), false, 'the planted removed-flag case must be a miss, proving the check can fail');
});
