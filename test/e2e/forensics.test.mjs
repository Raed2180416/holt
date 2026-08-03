/**
 * holt — "which agent destroyed what, and when", end to end.
 *
 * WHY THESE TESTS DRIVE THE REAL BINARY. The one thing this feature must never do is invent
 * attribution, and the only place attribution can be invented is the seam between the host and
 * holt — the hook payload. A unit test that hands `resolveActor` a well-formed object proves
 * nothing about whether the CLI reads that object at all. So every attribution test below pipes
 * a REAL host-shaped event into the real `holt hook` subprocess and then reads the journal file
 * that a real incident review would read.
 *
 * The payload shapes are not invented for the test: they are the field names measured out of the
 * shipping Claude Code binary (`session_id`, `tool_name`, `tool_input`, `tool_use_id`,
 * `hook_event_name`, `cwd`) and the shipping OpenCode runtime (`sessionID`, `callID`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { newRepo } from '../fixtures.mjs';
import { readJournal } from '../../src/journal.mjs';
import { forensics, __test as fx } from '../../src/forensics.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'holt.mjs');

/** Run the real CLI, optionally piping a host event to stdin, with a controlled environment. */
function holt(args, cwd, { stdin = null, env = {} } = {}) {
  return new Promise((resolve) => {
    // A CLEAN environment: this suite runs INSIDE an agent session, so the ambient CLAUDECODE /
    // AI_AGENT variables would silently attribute every fixture event to the agent running the
    // tests. That would make the "unknown stays unknown" tests pass for the wrong reason — the
    // exact shape of self-deception this project keeps catching.
    const base = { ...process.env, NO_COLOR: '1' };
    for (const k of Object.keys(base)) {
      if (/^(CLAUDE|CLAUDECODE|AI_AGENT|CURSOR|OPENCODE|HOLT_ACTOR)/.test(k)) delete base[k];
    }
    const child = execFile(process.execPath, [BIN, ...args], {
      cwd, timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: { ...base, ...env },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
    if (stdin != null) { child.stdin.write(stdin); child.stdin.end(); } else child.stdin.end();
  });
}

/** A repo with one worktree holding the only copy of something. */
async function repoWithWorkAtRisk(label) {
  const f = await newRepo(label);
  const wt = await f.worktree('payments');
  await f.write('src/payments.js', 'export function PAYMENTS_ONLY_HERE() { return 42; }\n', wt);
  return f;
}

const claudeEvent = (cwd, command, sessionId) => JSON.stringify({
  session_id: sessionId,
  transcript_path: '/home/x/.claude/projects/t.jsonl',
  cwd,
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_use_id: 'toolu_01FORENSIC',
});

/* ================================================ the blocked attempt is recorded ==== */

test('FORENSICS: a REFUSED destructive command is recorded, with the agent session that tried it', async (t) => {
  const f = await repoWithWorkAtRisk('forensics-blocked');
  t.after(() => f.cleanup());

  const target = path.join(f.root, '..', 'wt', 'payments');
  const r = await holt(['hook', 'pre-tool-use', '--host', 'claude-code'], f.root, {
    stdin: claudeEvent(f.root, `rm -rf ${target}`, 'sess-AAAA-1111'),
  });
  assert.equal(r.code, 1, `the hook must DENY this: ${r.stdout} ${r.stderr}`);

  const events = await readJournal(f.root);
  const blocked = events.filter((e) => e.action === 'blocked');
  assert.equal(blocked.length, 1, `the refused attempt must be journalled: ${JSON.stringify(events)}`);

  // THE WHOLE POINT: the refusal is bound to the session that produced it.
  assert.equal(blocked[0].actor.agent, 'claude-code');
  assert.equal(blocked[0].actor.session, 'sess-AAAA-1111');
  assert.equal(blocked[0].actor.confidence, 'reported');
  assert.equal(blocked[0].actor.invocation, 'toolu_01FORENSIC');
  assert.ok(blocked[0].command.includes('rm -rf'), 'the command that was tried must be preserved');
  assert.deepEqual(blocked[0].targets, ['payments'], 'and WHICH workstream it was aimed at');
});

test('FORENSICS: an attempt holt could NOT verify is recorded as `unverified`, not discarded', async (t) => {
  // `ask` matters more than `deny`, not less: deny means holt stopped it, ask means holt handed
  // the decision back to the host, which may well have proceeded. A timeline missing those has
  // destruction with no antecedent.
  //
  // THIS TEST ASSERTS THE EXACT ACTION, and that is not pedantry. The first version accepted
  // "blocked OR unverified", which is satisfied by the pre-existing deny path — so it passed
  // with the feature removed. A conditional assertion that is satisfied whichever way the
  // behaviour goes is not a test.
  const f = await repoWithWorkAtRisk('forensics-ask');
  t.after(() => f.cleanup());

  // A repository whose refs are gone: `git rev-parse --git-common-dir` still answers (so the
  // journal is writable) but the scan cannot resolve a base, which is exactly the shape of the
  // real thing — a repo holt cannot assess while a destructive command is in flight.
  await fs.rm(path.join(f.root, '.git', 'refs', 'heads'), { recursive: true, force: true });
  await fs.rm(path.join(f.root, '.git', 'packed-refs'), { force: true });

  const target = path.join(f.root, '..', 'wt', 'payments');
  const r = await holt(['hook', 'pre-tool-use', '--host', 'claude-code'], f.root, {
    stdin: claudeEvent(f.root, `rm -rf ${target}`, 'sess-BBBB-2222'),
  });
  assert.equal(r.code, 2, 'could-not-verify is exit 2, distinct from deny (1) and allow (0)');

  const events = await readJournal(f.root);
  const unverified = events.filter((e) => e.action === 'unverified');
  assert.equal(unverified.length, 1,
    `the attempt holt could not judge must be journalled as 'unverified': ${JSON.stringify(events)}`);
  assert.equal(unverified[0].actor.session, 'sess-BBBB-2222', 'attributed to the session that tried it');
  assert.ok(unverified[0].command.includes('rm -rf'));
});

test('FORENSICS: when holt cannot even reach the journal, it is LOUD rather than silent', async (t) => {
  // The honest limit of the line above, stated as a test rather than as a comment. Some
  // could-not-verify cases (a corrupt HEAD, an unreadable object store) leave holt unable to
  // resolve the git common dir, and the journal lives inside that directory — so the attempt
  // cannot be recorded at all. That must never be silent: a missing audit line the operator does
  // not know about is worse than a crash.
  const f = await repoWithWorkAtRisk('forensics-nojournal');
  t.after(() => f.cleanup());

  const target = path.join(f.root, '..', 'wt', 'payments');
  await fs.writeFile(path.join(f.root, '.git', 'HEAD'), 'not a ref\n');

  const r = await holt(['hook', 'pre-tool-use', '--host', 'claude-code'], f.root, {
    stdin: claudeEvent(f.root, `rm -rf ${target}`, 'sess-EEEE-5555'),
  });
  assert.equal(r.code, 2, 'it still refuses to silently allow what it could not check');
  assert.match(r.stderr, /journal: could not record/i,
    'a lost audit line must be announced on stderr, never dropped quietly');
});

test('FORENSICS: the OpenCode path carries its identity too (sessionID / callID via flags)', async (t) => {
  const f = await repoWithWorkAtRisk('forensics-opencode');
  t.after(() => f.cleanup());

  const target = path.join(f.root, '..', 'wt', 'payments');
  const r = await holt([
    'hook', 'pre-tool-use', '--host', 'opencode',
    '--command', `git worktree remove ${target}`,
    '--cwd', f.root, '--session', 'ses_7Kq9', '--invocation', 'call_42',
  ], f.root);
  assert.equal(r.code, 1, 'this must be denied');

  const blocked = (await readJournal(f.root)).find((e) => e.action === 'blocked');
  assert.equal(blocked.actor.agent, 'opencode');
  assert.equal(blocked.actor.session, 'ses_7Kq9');
  assert.equal(blocked.actor.invocation, 'call_42');
  assert.equal(blocked.actor.confidence, 'reported');
});

/* ==================================================== never invent, never leak ==== */

test('FORENSICS: a host that says nothing produces `unknown`, NOT the human running the shell', async (t) => {
  const f = await repoWithWorkAtRisk('forensics-anon');
  t.after(() => f.cleanup());

  const target = path.join(f.root, '..', 'wt', 'payments');
  await holt(['hook', 'pre-tool-use', '--host', 'generic', '--command', `rm -rf ${target}`, '--cwd', f.root],
    f.root, { env: { USER: 'raed', LOGNAME: 'raed', HOSTNAME: 'box-01' } });

  const blocked = (await readJournal(f.root)).find((e) => e.action === 'blocked');
  assert.ok(blocked, 'the refusal is still recorded — anonymity is not a reason to drop the line');
  assert.equal(blocked.actor.agent, 'unknown');
  assert.equal(blocked.actor.session, null);
  assert.equal(blocked.actor.confidence, 'unknown');
  const blob = JSON.stringify(blocked.actor);
  for (const leak of ['raed', 'box-01']) {
    assert.ok(!blob.includes(leak), `the human's identity leaked into the agent record: ${blob}`);
  }
});

/* ========================================================== the timeline itself ==== */

test('FORENSICS: `holt forensics <id>` reconstructs created / wrote / attempted / survived', async (t) => {
  const f = await repoWithWorkAtRisk('forensics-timeline');
  t.after(() => f.cleanup());

  const target = path.join(f.root, '..', 'wt', 'payments');
  await holt(['hook', 'pre-tool-use', '--host', 'claude-code'], f.root,
    { stdin: claudeEvent(f.root, `rm -rf ${target}`, 'sess-CCCC-3333') });
  await holt(['hook', 'pre-tool-use', '--host', 'claude-code'], f.root,
    { stdin: claudeEvent(f.root, `git worktree remove --force ${target}`, 'sess-DDDD-4444') });
  await holt(['protect'], f.root, { env: { AI_AGENT: 'opencode_1-18-3_agent', HOLT_ACTOR_SESSION: 'ses_prot' } });

  const r = await holt(['forensics', 'payments', '--json'], f.root);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);

  assert.equal(out.workstream, 'payments');
  assert.equal(out.attempts.blocked, 2, `both refusals must appear: ${JSON.stringify(out.attempts)}`);
  assert.equal(out.survived.status, 'present');
  assert.equal(out.survived.holdsUniqueWork, true, 'it survived BECAUSE holt refused');
  assert.ok(out.wrote.uncommittedFiles >= 1, 'what it wrote must be reported');

  // Two distinct agent sessions attacked it, plus one that protected it. They must not merge.
  const sessions = out.actors.map((a) => a.session).sort();
  assert.ok(sessions.includes('sess-CCCC-3333') && sessions.includes('sess-DDDD-4444'),
    `both attacking sessions must be distinguished: ${JSON.stringify(out.actors)}`);
  assert.equal(out.actors.filter((a) => a.blocked > 0).length, 2,
    'two different sessions were refused once each — collapsing them loses the whole finding');

  // Creation is git's fact, and is NOT attributed to an agent.
  //
  // ASSERTS A REAL ANSWER, not "one of these". The first version accepted `unknown`, and the
  // implementation returned `unknown` on every repository in existence because holt's own
  // read-only git allowlist refuses `reflog` — a silent degrade that a permissive assertion made
  // invisible. `how` must name the instrument that produced the date.
  assert.equal(out.created.how, 'git-reflog',
    `creation must come from git's own record, not from a swallowed failure: ${JSON.stringify(out.created)}`);
  assert.ok(out.created.at, 'and it must carry a date');
  assert.ok(!JSON.stringify(out.created).includes('sess-'), 'creation must not be attributed to a session');

  // git identity is reported, and reported SEPARATELY from agent identity.
  assert.ok(Array.isArray(out.gitAuthors));
  assert.ok(!out.actors.some((a) => String(a.agent).includes('holt test')),
    'the git author must never appear as an agent');
});

test('FORENSICS: silence is reported as silence, never as safety', async (t) => {
  const f = await repoWithWorkAtRisk('forensics-silence');
  t.after(() => f.cleanup());
  const r = await holt(['forensics', 'payments', '--json'], f.root);
  const out = JSON.parse(r.stdout);
  assert.equal(out.attempts.blocked, 0);
  assert.match(out.attempts.note, /not evidence nothing happened/i,
    'a repo with no hook installed and a quiet repo look identical from here, and must say so');
});

test('FORENSICS: an event predating identity capture is unattributed, never back-filled', async (t) => {
  const f = await repoWithWorkAtRisk('forensics-legacy');
  t.after(() => f.cleanup());

  // A journal line written by an older holt: no `actor` key at all.
  const common = path.join(f.root, '.git', 'holt');
  await fs.mkdir(common, { recursive: true });
  await fs.writeFile(path.join(common, 'journal.jsonl'),
    `${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', action: 'blocked', command: 'rm -rf payments', targets: ['payments'] })}\n`,
    'utf8');

  const r = await holt(['forensics', 'payments', '--json'], f.root);
  const out = JSON.parse(r.stdout);
  assert.equal(out.attempts.blocked, 1, 'the old line is still read');
  assert.equal(out.actors.length, 0, 'and attributed to NOBODY');
  assert.equal(out.unattributedEvents, 1, 'counted separately, in its own bucket');
  assert.match(out.note, /NOT attributed/i);
});

test('FORENSICS: an unrelated workstream\'s events do not contaminate the timeline', async (t) => {
  // Matching the id anywhere in the record made a block about `api` claim every event whose path
  // merely contained "api". A timeline with unrelated lines is worse than a short one.
  assert.equal(fx.eventConcerns({ action: 'blocked', command: 'rm -rf ../wt/api-v2' }, 'api'), false);
  assert.equal(fx.eventConcerns({ action: 'blocked', command: 'rm -rf ../wt/api' }, 'api'), true);
  assert.equal(fx.eventConcerns({ action: 'clean-remove', id: 'api' }, 'api'), true);
  assert.equal(fx.eventConcerns({ action: 'blocked', targets: ['api'] }, 'api'), true);
  assert.equal(fx.eventConcerns({ action: 'clean-remove', id: 'other', path: '/x/api/y' }, 'api'), false);
});

test('FORENSICS: the GENERATED OpenCode plugin forwards the session opencode hands it', async (t) => {
  // The flag path is proven above; this proves the generated plugin actually USES it. The plugin
  // is a string emitted by an adapter, so a plugin that silently dropped `input.sessionID` would
  // leave every OpenCode action anonymous while every CLI-level test stayed green — which is
  // exactly the state this shipped in.
  const { installOpenCode } = await import('../../src/integrate/adapters.mjs');
  const f = await repoWithWorkAtRisk('forensics-oc-plugin');
  t.after(() => f.cleanup());

  const { path: file } = await installOpenCode(f.root, { bin: `${process.execPath} ${BIN}` });
  const mod = await import(`file://${file}?t=${Math.random().toString(36).slice(2)}`);
  const hooks = await mod.holt({ project: {}, client: {}, $: () => { throw new Error('no shell'); }, directory: f.root, worktree: f.root });

  const target = path.join(f.root, '..', 'wt', 'payments');
  let threw = null;
  try {
    // The real argument shape, verified in the opencode binary: {tool, sessionID, callID}.
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses_PLUGIN_1', callID: 'call_PLUGIN_1' },
      { args: { command: `rm -rf ${target}` } },
    );
  } catch (e) { threw = e; }
  assert.ok(threw, 'the plugin must block this');

  const blocked = (await readJournal(f.root)).find((e) => e.action === 'blocked');
  assert.ok(blocked, 'and journal it');
  assert.equal(blocked.actor.session, 'ses_PLUGIN_1',
    'the session opencode handed the plugin must reach the journal');
  assert.equal(blocked.actor.invocation, 'call_PLUGIN_1');
  assert.equal(blocked.actor.agent, 'opencode');
});

/* ================================================================ the paid line ==== */

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const TEST_PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mintTeam() {
  const claims = { v: 1, id: 'lic-forensics', tier: 'team', org: 'Acme', seats: 10, iat: Date.now() - 1000, exp: Date.now() + 30 * 86_400_000 };
  const payload = b64url(JSON.stringify(claims));
  return `holt_team_${payload}.${b64url(edSign(null, Buffer.from(payload, 'utf8'), privateKey))}`;
}

test('PAID: fleet correlation REFUSES without a license, and says what is free', async (t) => {
  const f = await repoWithWorkAtRisk('forensics-unlicensed');
  t.after(() => f.cleanup());

  const r = await holt(['forensics', '--fleet', path.dirname(f.root)], f.root, { env: { HOLT_LICENSE: '' } });
  assert.equal(r.code, 3, 'an unlicensed paid feature exits 3');
  assert.match(r.stderr, /team license/i);
  assert.match(r.stderr, /without --fleet/,
    'the refusal must point at the free single-repo path rather than dead-ending the user');
  assert.equal(r.stdout.trim(), '', 'and it must leak no fleet data at all');

  // The free half is unaffected — that is the whole argument for where the line sits.
  const free = await holt(['forensics', 'payments', '--json'], f.root, { env: { HOLT_LICENSE: '' } });
  assert.equal(free.code, 0, 'single-repo forensics must remain free and working');
});

test('PAID: the gate is on the FEATURE, so importing the module directly is entitled too', async (t) => {
  // The CLI check and the module check are two different gates and only one of them was proven.
  // Measured: deleting the module-level gate left the CLI test green, because the CLI has its
  // own. A paid feature reachable by `import` is not gated — it is decorated.
  const { fleetForensics, EntitlementError } = await import('../../src/team/forensics-fleet.mjs');
  const f = await repoWithWorkAtRisk('forensics-import-gate');
  t.after(() => f.cleanup());

  await assert.rejects(
    () => fleetForensics([path.dirname(f.root)], { env: {} }),
    (e) => e instanceof EntitlementError && /team/i.test(e.message),
    'importing the module must refuse exactly as the command does',
  );
});

test('PAID: the correlation only a fleet can compute — refused in one repo, destructive in another', async (t) => {
  const { fleetForensics } = await import('../../src/team/forensics-fleet.mjs');

  const a = await repoWithWorkAtRisk('fleet-a');
  const b = await repoWithWorkAtRisk('fleet-b');
  t.after(() => Promise.all([a.cleanup(), b.cleanup()]));

  // ONE agent session, two repositories. Refused in A...
  const targetA = path.join(a.root, '..', 'wt', 'payments');
  await holt(['hook', 'pre-tool-use', '--host', 'claude-code'], a.root,
    { stdin: claudeEvent(a.root, `rm -rf ${targetA}`, 'sess-SHARED-9999') });

  // ...and, in B, it got a removal through (holt's own clean, recorded under the same session).
  await b.worktree('spent'); // disposable: clean will remove it
  await holt(['clean', '--apply'], b.root, {
    env: { AI_AGENT: 'claude-code_2-1-219_agent', CLAUDE_CODE_HOST_SESSION_ID: 'sess-SHARED-9999' },
  });

  // Both repos live under one parent, which is what a fleet root looks like.
  // EACH FIXTURE'S OWN PARENT, never a shared temp root. Using `dirname(dirname(root))` resolved
  // to os.tmpdir(), so the fleet walk swept every other test's fixtures — the assertion then
  // depended on what else was running, and passed in isolation while failing in the full suite.
  // A fleet test that scans the machine is not testing a fleet.
  const rootDir = path.dirname(a.root);
  const bRootDir = path.dirname(b.root);

  const out = await fleetForensics([rootDir, bRootDir], { maxDepth: 3, publicKeyB64: TEST_PUB, env: { HOLT_LICENSE: mintTeam() } });

  const shared = out.sessions.find((s) => s.session === 'sess-SHARED-9999');
  assert.ok(shared, `the shared session must be found across both repos: ${JSON.stringify(out.sessions, null, 1)}`);
  assert.equal(shared.repoCount, 2, 'and recognised as ONE session spanning two repositories');
  assert.ok(shared.blocked >= 1 && shared.destroyed >= 1);

  const finding = out.refusedThenDestroyed.find((x) => x.session === 'sess-SHARED-9999');
  assert.ok(finding, 'the headline correlation must fire');
  assert.equal(finding.differentRepo, true,
    'blocked in one repo and destructive in a DIFFERENT one — neither repo can see this alone');

  // And the single-repo view provably CANNOT produce it. This is the paid/free argument, run.
  const soloA = await forensics(a.root, {});
  const soloB = await forensics(b.root, {});
  assert.equal(soloA.actors.find((x) => x.session === 'sess-SHARED-9999')?.destroyed ?? 0, 0,
    'repo A alone sees a block and no damage');
  assert.equal(soloB.actors.find((x) => x.session === 'sess-SHARED-9999')?.blocked ?? 0, 0,
    'repo B alone sees a removal with no antecedent');
});

test('PAID: the fleet join NEVER correlates events that carry no session', async (t) => {
  const { fleetForensics } = await import('../../src/team/forensics-fleet.mjs');
  const a = await repoWithWorkAtRisk('fleet-anon-a');
  const b = await repoWithWorkAtRisk('fleet-anon-b');
  t.after(() => Promise.all([a.cleanup(), b.cleanup()]));

  // Two repos, two anonymous refusals. Joining them would report "one agent did all of this".
  for (const f of [a, b]) {
    const target = path.join(f.root, '..', 'wt', 'payments');
    await holt(['hook', 'pre-tool-use', '--host', 'generic', '--command', `rm -rf ${target}`, '--cwd', f.root], f.root);
  }

  const out = await fleetForensics(
    [path.dirname(a.root), path.dirname(b.root)],
    { maxDepth: 3, publicKeyB64: TEST_PUB, env: { HOLT_LICENSE: mintTeam() } },
  );
  assert.equal(out.totals.sessions, 0, 'nothing may be correlated from anonymous events');
  assert.equal(out.totals.unattributedEvents, 2, 'they are counted, in their own bucket');
  assert.equal(out.refusedThenDestroyed.length, 0);
  assert.match(out.note, /never guessed at/i);
});
