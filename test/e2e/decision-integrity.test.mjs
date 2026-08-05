// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — DECISION INTEGRITY: the guard's answer must never be ABSENT, and never be BYPASSED
 * without anyone noticing.
 *
 * Two measured defects, one fault. The host is told "proceed" by code that never formed an
 * opinion about the command.
 *
 *   [A] ABSENT.  Any exception inside the analysis left through `main().catch` — the CLI's error
 *       handler — which exits 1. For a CLI that is correct; for a PreToolUse hook the host's own
 *       documentation is explicit that 1 is a NON-BLOCKING error and "Execution continues".
 *       MEASURED, through the real hook, against a worktree holding the only copy of its content:
 *           rm -rf ../vc-wt          -> exit 2, blocked          (the control)
 *           rm -rf x[z-a] ../vc-wt   -> exit 1, and the worktree was DELETED
 *
 *   [C] BYPASSED. A `guardAllow` entry was matched with an UNANCHORED `RegExp.test` over the raw
 *       command text, so it approved anything the approved text appeared inside.
 *       MEASURED with {"guardAllow":["rm -rf dist"]}:
 *           rm -rf dist; rm -rf ../vc-wt        -> ALLOW
 *           rm -rf dist && rm -rf ../vc-wt      -> ALLOW
 *           rm -rf ../vc-wt # rm -rf dist       -> ALLOW   (a COMMENT)
 *           echo "rm -rf dist" && rm -rf ../vc-wt -> ALLOW (a string LITERAL)
 *           rm -rf distant-relative             -> ALLOW   (a different operand)
 *       …and every one of those allows was emitted SILENTLY: exit 0 with an empty stdout.
 *
 * Every assertion here is on the exit code of the REAL binary run as a subprocess with a REAL
 * host payload on stdin, because the exit code is the only part of a hook's answer that every
 * host reads the same way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRepo } from '../fixtures.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'holt.mjs');

function hook(bin, cwd, command, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [bin, 'hook', 'pre-tool-use', '--host', 'claude-code'], {
      cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', ...env },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
    child.stdin.end(JSON.stringify({
      session_id: 'decision-integrity', cwd, hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command },
    }));
  });
}

/** A repo with one worktree whose content exists in no commit, index entry or stash. */
async function fixture(label) {
  const fx = await newRepo(label);
  const wt = await fx.worktree('holds');
  await fx.write('src/only-copy.js', 'export function ONLY_COPY_SYMBOL() { return 41; }\n', wt);
  return fx;
}

/**
 * A COPY OF holt WITH ONE LINE ADDED: `assessCommand` throws when HOLT_FAULT_TEST is set.
 *
 * The alternative — reaching for an input that happens to make the CURRENT analyser throw — pins
 * nothing: the day that input is fixed the test goes green while testing nothing, which is the
 * exact vacuity this project's ratchet tests exist to refuse. An injected fault is a fault that
 * stays injected. If the needle ever stops matching, this THROWS rather than quietly skipping.
 */
async function faultInjectedHolt(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-fault-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  await fs.cp(path.join(ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true });
  await fs.cp(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  // Dependencies resolve from the real installation; only the source under test is a copy.
  await fs.symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');

  const agentPath = path.join(dir, 'src', 'agent.mjs');
  const source = await fs.readFile(agentPath, 'utf8');
  const start = source.indexOf('export async function assessCommand(command, cwd = process.cwd(), {');
  const endMarker = '} = {}) {\n';
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end >= 0,
    'the fault-injection needle no longer matches assessCommand — this test is measuring nothing '
    + 'until it is updated, which is the one outcome it must never have');
  const injection = "  if (process.env.HOLT_FAULT_TEST) throw new Error('injected analyser fault');\n";
  const at = end + endMarker.length;
  await fs.writeFile(agentPath, source.slice(0, at) + injection + source.slice(at));
  return path.join(dir, 'bin', 'holt.mjs');
}

/* ------------------------------------------------- [A] the answer must never be ABSENT ---- */

test('HOOK FAILURE: an analyser crash on a destructive command STOPS it — exit 2, never the '
  + 'non-blocking exit 1 that runs it', async (t) => {
  const fx = await fixture('di-crash-destructive');
  t.after(() => fx.cleanup());
  const bin = await faultInjectedHolt(t);
  const command = `rm -rf ${fx.wt('holds')}`;

  const control = await hook(bin, fx.root, command);
  assert.equal(control.code, 2, `the control must block with a working analyser: ${JSON.stringify(control)}`);

  const crashed = await hook(bin, fx.root, command, { HOLT_FAULT_TEST: '1' });
  assert.notEqual(crashed.code, 1,
    `exit 1 is a NON-BLOCKING error: the host runs the command. ${JSON.stringify(crashed)}`);
  assert.equal(crashed.code, 2,
    `a crash on a destructive command must block: ${JSON.stringify(crashed)}`);
  assert.match(crashed.stderr + crashed.stdout, /analysis failed/i,
    `the refusal must say holt broke, not invent evidence: ${crashed.stderr}${crashed.stdout}`);
});

test('HOOK FAILURE: an analyser crash on a command with no destructive verb lets it through — '
  + 'but says so, out loud, in the host\'s own user-visible channel', async (t) => {
  const fx = await fixture('di-crash-ordinary');
  t.after(() => fx.cleanup());
  const bin = await faultInjectedHolt(t);

  for (const command of ['git status', 'npm test', 'ls -la src']) {
    const r = await hook(bin, fx.root, command, { HOLT_FAULT_TEST: '1' });
    assert.equal(r.code, 0,
      `fail-closed must be SCOPED — ordinary work must not stop because holt broke: ${command} -> ${JSON.stringify(r)}`);
    assert.match(r.stdout, /"systemMessage"/,
      `an unchecked command must never look like a checked one: ${command} -> ${r.stdout}`);
    assert.match(r.stdout + r.stderr, /analysis failed/i,
      `the failure must name itself: ${command} -> ${r.stdout}${r.stderr}`);
  }
});

test('HOOK FAILURE: a crash BEFORE the command is read cannot be scoped, so it is not scoped — '
  + 'it blocks', async (t) => {
  const fx = await fixture('di-crash-early');
  t.after(() => fx.cleanup());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holt-fault-early-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  await fs.cp(path.join(ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true });
  await fs.cp(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  await fs.symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const binPath = path.join(dir, 'bin', 'holt.mjs');
  const source = await fs.readFile(binPath, 'utf8');
  const needle = 'async function cmdHook(opts) {';
  assert.ok(source.includes(needle), 'the pre-read fault-injection needle no longer matches cmdHook');
  await fs.writeFile(binPath, source.replace(needle,
    `${needle}\n  if (process.env.HOLT_FAULT_EARLY_TEST) throw new Error('injected pre-read fault');`));

  const r = await hook(binPath, fx.root, `rm -rf ${fx.wt('holds')}`, { HOLT_FAULT_EARLY_TEST: '1' });
  assert.equal(r.code, 2,
    `a failure before the command was read must not resolve to "nothing destructive here": ${JSON.stringify(r)}`);
});

test('HOOK FAILURE: the break-glass is out-of-band, and every command it lets through is '
  + 'announced', async (t) => {
  const fx = await fixture('di-breakglass');
  t.after(() => fx.cleanup());
  const bin = await faultInjectedHolt(t);
  const command = `rm -rf ${fx.wt('holds')}`;

  const closed = await hook(bin, fx.root, command, { HOLT_FAULT_TEST: '1' });
  assert.equal(closed.code, 2, `without the break-glass a crash must block: ${JSON.stringify(closed)}`);

  const open = await hook(bin, fx.root, command, { HOLT_FAULT_TEST: '1', HOLT_HOOK_FAIL_OPEN: '1' });
  assert.equal(open.code, 0, `the break-glass must actually work: ${JSON.stringify(open)}`);
  assert.match(open.stdout, /"systemMessage"/,
    `fail-open may be permitted, never silent: ${open.stdout}`);
  assert.match(open.stdout + open.stderr, /did NOT check|unguarded/,
    `the stamp must say the command was not checked: ${open.stdout}${open.stderr}`);
});

/* ------------------------------------------ [C] the answer must never be BYPASSED ---- */

/** With `guardAllow: [entry]` in .holtrc.json, run each command and return its exit code. */
async function withAllow(t, label, entries, commands) {
  const fx = await fixture(label);
  t.after(() => fx.cleanup());
  await fx.write('.holtrc.json', JSON.stringify({ guardAllow: entries }));
  const out = {};
  for (const command of commands) {
    out[command] = await hook(BIN, fx.root, command);
  }
  return { fx, out };
}

/**
 * THE ENTRY IS DELIBERATELY UNANCHORED — `"rm -rf dist"`, not `"^rm -rf dist$"`.
 *
 * That is the entry a human writes, it is the entry holt's own deny message used to ask for
 * ("add a matching guardAllow pattern"), and it is the one the bypass was measured with. An
 * already-anchored entry resists chaining even on the old unanchored matcher, so a test written
 * with one proves nothing about the defect. Anchoring is now the MATCHER's job, not the
 * config author's, precisely because the config author cannot be relied on to do it.
 */
test('guardAllow: an approval authorises the command the human reviewed — a chain, a comment '
  + 'and a string literal do not inherit it', async (t) => {
  const fx = await fixture('di-allow-scope');
  t.after(() => fx.cleanup());
  const wt = fx.wt('holds');
  await fx.write('.holtrc.json', JSON.stringify({ guardAllow: ['rm -rf dist'] }));

  const approved = await hook(BIN, fx.root, 'rm -rf dist');
  assert.equal(approved.code, 0, `the reviewed command must still be approved: ${JSON.stringify(approved)}`);

  const control = await hook(BIN, fx.root, `rm -rf ${wt}`);
  assert.equal(control.code, 2, `the control must block: ${JSON.stringify(control)}`);

  const bypasses = [
    `rm -rf dist; rm -rf ${wt}`,                  // chained with ;
    `rm -rf dist && rm -rf ${wt}`,                // chained with &&
    `rm -rf dist || rm -rf ${wt}`,                // chained with ||
    `rm -rf ${wt} # rm -rf dist`,                 // a COMMENT
    `echo "rm -rf dist" && rm -rf ${wt}`,         // a string LITERAL
    `rm -rf dist\nrm -rf ${wt}`,                  // a newline
    `rm -rf dist | tee log; rm -rf ${wt}`,        // a pipeline, then a chain
  ];
  for (const command of bypasses) {
    const r = await hook(BIN, fx.root, command);
    assert.equal(r.code, 2,
      `an approval of "rm -rf dist" must not authorise ${JSON.stringify(command)}: ${JSON.stringify(r)}`);
  }
});

test('guardAllow: the same verb with a different operand is a different command', async (t) => {
  const fx = await fixture('di-allow-operand');
  t.after(() => fx.cleanup());
  const wt = fx.wt('holds');
  await fx.write('.holtrc.json', JSON.stringify({ guardAllow: ['rm -rf dist'] }));

  const approved = await hook(BIN, fx.root, 'rm -rf dist');
  assert.equal(approved.code, 0, `the reviewed command must be approved: ${JSON.stringify(approved)}`);

  // The approved text occurs as a PREFIX of a longer operand, and as the first of two operands.
  // Neither is the command anybody read.
  for (const command of [`rm -rf dist ${wt}`, 'rm -rf distant-relative']) {
    const r = await hook(BIN, fx.root, command);
    assert.notEqual(r.allowlisted, true);
    if (command.includes(wt)) {
      assert.equal(r.code, 2,
        `"rm -rf dist" must not approve a second operand nobody reviewed: ${JSON.stringify(r)}`);
    }
    assert.doesNotMatch(r.stdout, /guardAllow/,
      `${JSON.stringify(command)} must not be reported as allowlisted: ${r.stdout}`);
  }
});

test('guardAllow: a compound command is approved only when EVERY one of its commands was', async (t) => {
  const fx = await fixture('di-allow-compound');
  t.after(() => fx.cleanup());
  const wt = fx.wt('holds');
  const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await fx.write('.holtrc.json', JSON.stringify({
    guardAllow: [`^${escaped(`rm -rf ${wt}`)}$`, '^npm run build$'],
  }));

  const both = await hook(BIN, fx.root, `rm -rf ${wt} && npm run build`);
  assert.equal(both.code, 0,
    `every part reviewed means the whole is approved: ${JSON.stringify(both)}`);

  const partial = await hook(BIN, fx.root, `rm -rf ${wt} && rm -rf ${fx.wt('holds')}/src`);
  assert.equal(partial.code, 2,
    `one unreviewed command voids the approval: ${JSON.stringify(partial)}`);
});

test('guardAllow: leading and trailing whitespace is not part of a command', async (t) => {
  const fx = await fixture('di-allow-space');
  t.after(() => fx.cleanup());
  const wt = fx.wt('holds');
  const escaped = `^${`rm -rf ${wt}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  await fx.write('.holtrc.json', JSON.stringify({ guardAllow: [escaped] }));

  // The command IS destructive, so an exit 0 here is load-bearing: only the approval can produce
  // it. Without the trim, the anchored entry misses and the deny stands.
  const control = await hook(BIN, fx.root, `rm -rf ${wt}`);
  assert.equal(control.code, 0, `the exact approval must work: ${JSON.stringify(control)}`);
  const padded = await hook(BIN, fx.root, `   rm -rf ${wt}   `);
  assert.equal(padded.code, 0, `whitespace must not void an approval: ${JSON.stringify(padded)}`);
});

test('guardAllow: an entry whose wildcard can span a command separator is DECLINED, loudly', async (t) => {
  const fx = await fixture('di-allow-wildcard');
  t.after(() => fx.cleanup());
  const wt = fx.wt('holds');
  await fx.write('.holtrc.json', JSON.stringify({ guardAllow: ['^rm -rf dist.*$'] }));

  const smuggled = await hook(BIN, fx.root, `rm -rf dist; rm -rf ${wt}`);
  assert.equal(smuggled.code, 2,
    `".*" must not approve a command nobody reviewed: ${JSON.stringify(smuggled)}`);

  const declined = await hook(BIN, fx.root, 'rm -rf dist');
  assert.match(declined.stderr, /ignoring "guardAllow" entry/,
    `a declined entry must say so — a silently ignored config is the same lie in the other `
    + `direction: ${declined.stderr}`);

  // ANTI-VACUITY: a BOUNDED pattern must still work, or the rule above is just "reject everything".
  const fx2 = await fixture('di-allow-wildcard-ok');
  t.after(() => fx2.cleanup());
  await fx2.write('.holtrc.json', JSON.stringify({ guardAllow: ['^rm -rf (dist|build)$'] }));
  const ok = await hook(BIN, fx2.root, 'rm -rf build');
  assert.equal(ok.code, 0, `a bounded alternation must still approve: ${JSON.stringify(ok)}`);
  assert.doesNotMatch(ok.stderr, /ignoring "guardAllow" entry/,
    `a bounded entry must not be declined: ${ok.stderr}`);
});

test('guardAllow: a destroyer that got through on an allowlist entry is ANNOUNCED, never silent', async (t) => {
  const fx = await fixture('di-allow-visible');
  t.after(() => fx.cleanup());
  const wt = fx.wt('holds');
  const escaped = `^${`rm -rf ${wt}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  await fx.write('.holtrc.json', JSON.stringify({ guardAllow: [escaped] }));

  const r = await hook(BIN, fx.root, `rm -rf ${wt}`);
  assert.equal(r.code, 0, `the escape hatch must still work: ${JSON.stringify(r)}`);
  assert.match(r.stdout, /"systemMessage"/,
    `the one command in the session that overruled holt's evidence must not be the one command `
    + `holt says nothing about: ${JSON.stringify(r)}`);
  assert.match(r.stdout, /guardAllow/,
    `the stamp must name what overruled the guard: ${r.stdout}`);
});

test('guardAllow: one uncompilable entry does not disable the entries after it', async (t) => {
  // Asserted against the matcher directly: `loadConfig` refuses an uncompilable entry before the
  // CLI ever reaches this code, so the CLI cannot reach the defect — but every OTHER caller of
  // assessCommand (the MCP server, the library API, a host adapter) passes patterns straight
  // through. The old matcher `return null`ed on the first entry that failed to compile, silently
  // abandoning every approval after it.
  const { guardAllowPattern } = await import('../../src/config.mjs');
  assert.equal(guardAllowPattern('rm -rf dist', ['(', 'rm -rf dist']), 'rm -rf dist',
    'a bad entry must be skipped, not end the search');
  assert.equal(guardAllowPattern('rm -rf dist', ['rm -rf dist']), 'rm -rf dist');
  assert.equal(guardAllowPattern('rm -rf dist; rm -rf ../wt', ['rm -rf dist']), null,
    'the matcher itself must be anchored — it is what every caller relies on');
});

/* ------------------------------------------------------------- the shared property ---- */

test('DECISION INTEGRITY: the PreToolUse hook never exits 1, on any input', async (t) => {
  const fx = await fixture('di-never-exit-1');
  t.after(() => fx.cleanup());
  const wt = fx.wt('holds');
  const hostile = [
    '', ' ', '\u0000', '﻿rm -rf x', 'rm -rf x[z-a]', `rm -rf 'x[z-a]' ${wt}`,
    'echo "unterminated', 'cat <<EOF\nrm -rf x', 'rm -rf $(', '('.repeat(500),
    '../'.repeat(2000), 'x'.repeat(50_000), `rm -rf ${wt}`, 'git status',
    'for i in a b c; do rm -rf "$i"; done', 'rm -rf {a,b,c}', 'rm -rf *',
  ];
  for (const command of hostile) {
    const r = await hook(BIN, fx.root, command);
    assert.ok(r.code === 0 || r.code === 2,
      `exit ${r.code} is neither allow nor block, and for a PreToolUse hook anything that is not `
      + `2 runs the command: ${JSON.stringify(command).slice(0, 80)} -> ${JSON.stringify(r).slice(0, 300)}`);
  }
});
