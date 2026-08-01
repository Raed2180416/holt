/**
 * holt Team — the paid layer, attacked on REAL repositories.
 *
 * Every test here goes through the production path — real git, real discover/scan/analyze — and
 * never through a hand-built object. That is the whole point: all three defects these tests pin
 * were GREEN against hand-made fixtures and inert against the shape the scanner actually
 * produces, which is the failure mode a unit test cannot see by construction.
 *
 *   fleet            counted a linked worktree as a separate repository, inflating every total.
 *   protected-paths  matched globs against symbol IDENTITIES (`callable:foo`), so a policy that
 *                    should fail passed on every real repository it was ever pointed at.
 *   unprotect        removed protection from irreplaceable work and wrote no audit line, so the
 *                    journal positively asserted a safer state than the repository was in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRepo } from '../fixtures.mjs';
import { samePathAsync } from '../../src/paths.mjs';

// findRepos returns ABSOLUTE paths; the relative form is this test's own display convention. Built
// with path.relative it carries the OS separator, so Windows produced 'nested\\two' against an
// expectation of 'nested/two' — a failure of the assertion's spelling, not of the product.
const posixRel = (root, p) => path.relative(root, p).split(path.sep).join('/');
import { findRepos } from '../../src/team/fleet.mjs';
import { evaluatePolicy } from '../../src/team/policy.mjs';
import { discover } from '../../src/discover.mjs';
import { scan } from '../../src/scan.mjs';
import { analyze } from '../../src/analyze.mjs';
import { protect, unprotect } from '../../src/actions.mjs';
import { readJournal } from '../../src/journal.mjs';

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'holt test', GIT_AUTHOR_EMAIL: 't@holt.invalid',
        GIT_COMMITTER_NAME: 'holt test', GIT_COMMITTER_EMAIL: 't@holt.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

async function scratch(label) {
  const base = process.env.HOLT_TMPDIR || os.tmpdir();
  return fs.mkdtemp(path.join(base, `holt-team-${label}-`));
}

async function repoAt(dir) {
  await fs.mkdir(dir, { recursive: true });
  await sh('git', ['init', '--initial-branch=main', '-q'], dir);
  await sh('git', ['config', 'user.name', 'holt test'], dir);
  await sh('git', ['config', 'user.email', 't@holt.invalid'], dir);
  await sh('git', ['config', 'commit.gpgsign', 'false'], dir);
  await fs.writeFile(path.join(dir, 'README.md'), '# r\n');
  await sh('git', ['add', '-A'], dir);
  await sh('git', ['commit', '-m', 'base', '--no-verify'], dir);
  return dir;
}

const write = async (dir, rel, body) => {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
};

/* ================================================================== FLEET ==== */

test('FLEET: a linked worktree is the SAME repository, not another one', async (t) => {
  const root = await scratch('fleet');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const alpha = await repoAt(path.join(root, 'alpha'));
  await repoAt(path.join(root, 'beta'));
  await repoAt(path.join(root, 'gamma'));
  // Two linked worktrees, parked beside the repo — the exact layout holt exists for. Before the
  // fix `findRepos` keyed on the directory path, so these two counted as two more repositories
  // and every fleet total double-counted their contents.
  await sh('git', ['worktree', 'add', '-b', 'wt/one', path.join(root, 'trees', 'alpha-one')], alpha);
  await sh('git', ['worktree', 'add', '-b', 'wt/two', path.join(root, 'trees', 'alpha-two')], alpha);

  const found = await findRepos([root], { maxDepth: 4 });

  // Ground truth comes from git, never from a number written into this test.
  const identities = new Set();
  for (const dir of [...found, path.join(root, 'trees', 'alpha-one')]) {
    const r = await sh('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], dir);
    identities.add(r.stdout.trim());
  }
  assert.equal(found.length, identities.size,
    `fleet reported ${found.length} repositories where git reports ${identities.size}: ${found.join(', ')}`);
  assert.deepEqual(found.map((p) => posixRel(root, p)).sort(), ['alpha', 'beta', 'gamma']);
  assert.ok(found.includes(alpha), 'the MAIN working tree is the one kept, not a linked one');
});

test('FLEET NEVER-WORSE: distinct repositories are never merged, and an unidentifiable directory is still reported', async (t) => {
  const root = await scratch('fleet-neg');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await repoAt(path.join(root, 'one'));
  await repoAt(path.join(root, 'nested', 'two'));
  // A CLONE shares content but is its own repository, and must stay its own row.
  await sh('git', ['clone', '-q', path.join(root, 'one'), path.join(root, 'one-clone')], root);
  // A directory carrying a `.git` git cannot make sense of. Dropping it would be fail-open:
  // it must still be reported, so the fleet scan surfaces it as a FAILURE rather than silence.
  await fs.mkdir(path.join(root, 'broken'), { recursive: true });
  await fs.writeFile(path.join(root, 'broken', '.git'), 'gitdir: /nowhere/at/all\n');

  const found = (await findRepos([root], { maxDepth: 4 })).map((p) => posixRel(root, p)).sort();
  assert.deepEqual(found, ['broken', 'nested/two', 'one', 'one-clone']);
});

/* ================================================================= POLICY ==== */

/** Build a repo whose worktrees hold uncommitted work, and return the real analyze() report. */
async function policyFixture(root) {
  const repo = await repoAt(path.join(root, 'repo'));
  await write(repo, 'infra/placeholder.txt', 'x\n');
  await write(repo, 'src/app.js', 'export function app() { return 1; }\n');
  await sh('git', ['add', '-A'], repo);
  await sh('git', ['commit', '-m', 'infra and src exist on base', '--no-verify'], repo);

  const wt = async (name) => {
    const p = path.join(root, 'trees', name);
    await sh('git', ['worktree', 'add', '-b', `wt/${name}`, p], repo);
    return p;
  };

  // (a) uncommitted work under a protected path, in files a parser CAN read.
  const parsed = await wt('parsed');
  await write(parsed, 'infra/deploy.mjs', 'export function deployProductionCluster() { return 1; }\n');

  // (b) uncommitted work under a protected path, in a file NO parser understands. This is the
  //     marquee case (notes, .env, CSV, a design asset) and the reason reading a symbol's `file`
  //     would still not have been enough: no symbol is produced for it at all.
  const opaque = await wt('opaque');
  await write(opaque, 'infra/db-snapshot.dat', 'gAAAAB opaque bytes\n');

  // (c) NEGATIVE CONTROL: uncommitted work nowhere near the protected paths.
  const elsewhere = await wt('elsewhere');
  await write(elsewhere, 'docs/notes.md', '# just notes\n');

  return analyze(await scan(await discover(repo, {}), {}), {});
}

test('POLICY: protected-paths fires on the shape the SCANNER produces, not only on hand-built objects', async (t) => {
  const root = await scratch('policy');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await policyFixture(root);

  const res = evaluatePolicy(
    { version: 1, rules: [{ id: 'prot', type: 'protected-paths', paths: ['infra/**'] }] },
    { audit: { unlanded: [], unknown: [] }, report },
  );

  assert.equal(res.ok, false, 'a policy that SHOULD fail must not pass');
  const subjects = res.violations.map((v) => v.subject).sort();
  assert.deepEqual(subjects, ['opaque', 'parsed'],
    'both the parseable and the unparseable file must be caught, and nothing else');

  const parsed = res.violations.find((v) => v.subject === 'parsed');
  assert.deepEqual(parsed.evidence, ['infra/deploy.mjs'],
    'evidence must be a PATH — a symbol identity like callable:deployProductionCluster is not one');
  const opaque = res.violations.find((v) => v.subject === 'opaque');
  assert.deepEqual(opaque.evidence, ['infra/db-snapshot.dat']);
  for (const v of res.violations) assert.match(v.message, /UNCOMMITTED/);
});

test('POLICY NEVER-WORSE: a glob that matches only a symbol identity fires on nothing', async (t) => {
  const root = await scratch('policy-neg');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await policyFixture(root);

  // `callable:deployProductionCluster` is the key the old code matched against. A rule shaped
  // like that key must now match nothing at all — otherwise the fix merely moved the category
  // error rather than removing it.
  for (const paths of [['callable*'], ['callable/**'], ['**deployProductionCluster']]) {
    const res = evaluatePolicy({ version: 1, rules: [{ id: 'k', type: 'protected-paths', paths }] },
      { audit: { unlanded: [], unknown: [] }, report });
    assert.equal(res.ok, true, `a symbol-identity glob must match no path: ${paths[0]}`);
  }

  // And a repository with nothing under the protected paths still passes: the rule must not have
  // become a blanket "any uncommitted work is a violation".
  const clean = evaluatePolicy(
    { version: 1, rules: [{ id: 'prot', type: 'protected-paths', paths: ['nowhere/**'] }] },
    { audit: { unlanded: [], unknown: [] }, report },
  );
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.violations, []);
});

/* ================================================================ JOURNAL ==== */

test('JOURNAL: unprotect — the action that REMOVES protection — is recorded like every other', async (t) => {
  const root = await scratch('journal');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const repo = await repoAt(path.join(root, 'repo'));
  const wtPath = path.join(root, 'trees', 'agent-1');
  await sh('git', ['worktree', 'add', '-b', 'wt/agent-1', wtPath], repo);
  await write(wtPath, 'notes.md', 'work that exists nowhere else\n');

  const p = await protect(repo, {});
  assert.equal(p.protected, 1, 'the worktree holding unique work must be locked');

  const u = await unprotect(repo, {});
  assert.equal(u.unlocked, 1);

  const events = await readJournal(repo);
  assert.deepEqual(events.map((e) => e.action), ['protect', 'unprotect'],
    'an audit trail with a hole exactly where the risky action is has no value');

  const rec = events[1];
  const prot = events[0];
  // SAME SHAPE as the others: every key protect records, unprotect records too.
  for (const k of ['at', 'actor', 'action', 'id', 'path', 'reason']) {
    assert.ok(k in rec, `unprotect entry is missing '${k}'`);
    assert.ok(k in prot, `protect entry is missing '${k}'`);
  }
  assert.equal(rec.id, 'agent-1');
  // COMPARED THROUGH paths.mjs, NOT path.resolve. The journal records the CANONICAL path holt
  // resolved (/private/var/... on macOS) while the fixture holds what mkdtemp returned
  // (/var/...), so path.resolve — which makes a path absolute but does not follow symlinks —
  // reports two different strings for one directory. Fourth instance of this class in test code
  // this session; the guard that keeps src/ honest does not reach here.
  assert.ok(await samePathAsync(rec.path, wtPath),
    `the journal must record this worktree: ${rec.path} vs ${wtPath}`);
  assert.equal(rec.forced, false);
  assert.equal(rec.foreignLock, false);
});

test('JOURNAL NEVER-WORSE: nothing is recorded when nothing was released', async (t) => {
  const root = await scratch('journal-neg');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const repo = await repoAt(path.join(root, 'repo'));
  const wtPath = path.join(root, 'trees', 'agent-1');
  await sh('git', ['worktree', 'add', '-b', 'wt/agent-1', wtPath], repo);
  await write(wtPath, 'notes.md', 'work that exists nowhere else\n');

  // A lock somebody ELSE placed is left alone — and an action that did not happen must not be
  // recorded as if it had. A journal that logs intent rather than effect is not an audit trail.
  await sh('git', ['worktree', 'lock', '--reason', 'human: do not touch', wtPath], repo);
  const u = await unprotect(repo, {});
  assert.equal(u.unlocked, 0);
  assert.equal(u.actions[0].action, 'skipped-foreign-lock');
  assert.deepEqual(await readJournal(repo), []);

  // With --force the same call DOES release it, and that override is recorded as an override.
  const forced = await unprotect(repo, { force: true });
  assert.equal(forced.unlocked, 1);
  const events = await readJournal(repo);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'unprotect');
  assert.equal(events[0].forced, true);
  assert.equal(events[0].foreignLock, true);
});

test('JOURNAL: every recorded action names WHO, and never invents one', async (t) => {
  const root = await scratch('journal-who');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const repo = await repoAt(path.join(root, 'repo'));
  const wtPath = path.join(root, 'trees', 'agent-1');
  await sh('git', ['worktree', 'add', '-b', 'wt/agent-1', wtPath], repo);
  await write(wtPath, 'notes.md', 'work that exists nowhere else\n');
  await protect(repo, {});
  await unprotect(repo, {});

  for (const e of await readJournal(repo)) {
    assert.ok(e.actor, `${e.action} has no actor`);
    for (const k of ['user', 'host', 'agent', 'session', 'source']) {
      assert.equal(typeof e.actor[k], 'string', `${e.action}.actor.${k} must be a string`);
      assert.ok(e.actor[k].length > 0, `${e.action}.actor.${k} must never be empty`);
    }
  }
});


test('POLICY AUTHORITY e2e: deleting the policy on the branch does not disarm `holt ci`', async (t) => {
  // The unit test above exercises the reader with a stub. This drives the SHIPPED COMMAND, which
  // is where the defect actually lived: both arms of the old expression resolved to the local
  // filesystem, so the PR checkout supplied its own rules.
  //
  // The tell is precise and needs no licence to observe. `holt ci` only reaches the
  // `unlicensed-policy` refusal when a policy was FOUND; if the gate is reading the working tree,
  // a branch that deleted the file yields found:false and the command passes silently. So the
  // presence of the entitlement refusal IS the proof that the base ref was consulted.
  const fx = await newRepo('policy-authority');
  t.after(() => fx.cleanup());

  await fx.write('.holt/policy.json', JSON.stringify({
    version: 1,
    rules: [{ id: 'no-abandoned-work', type: 'no-unlanded', severity: 'error' }],
  }, null, 2));
  await fx.commit('the base branch declares a policy');

  // The attacker's branch: delete the file that judges it.
  await fx.git(['checkout', '-q', '-b', 'sneaky']);
  await fs.rm(path.join(fx.root, '.holt', 'policy.json'), { force: true });
  await fx.commit('remove the policy');

  const bin = fileURLToPath(new URL('../../bin/holt.mjs', import.meta.url));
  const r = await sh('node', [bin, 'ci', '--base', 'main', '--json'], fx.root);
  const out = `${r.stdout}${r.stderr}`;

  // FIXTURE VALIDITY: the file really is gone from the working tree.
  await assert.rejects(() => fs.stat(path.join(fx.root, '.holt', 'policy.json')),
    'the fixture is void unless the branch really deleted the policy');

  assert.match(out, /policy/i,
    `the gate must still see a policy from the base ref, got: ${out.slice(0, 500)}`);
  assert.ok(/unlicensed-policy|violation|no-abandoned-work/i.test(out),
    `a policy deleted on the branch must still be enforced from the base ref, got: ${out.slice(0, 500)}`);
  assert.notEqual(r.code, 0,
    `the gate must not report a clean pass on a branch that deleted its own policy (exit ${r.code}): ${out.slice(0, 400)}`);
});
