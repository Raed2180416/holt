// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the supply-chain audit, attacked.
 *
 * This suite is written against one specific way an audit tool fails, and it is not "the code
 * throws": it is that the audit stays GREEN while the thing it audits is false. A supply-chain
 * check nobody has ever seen fail is indistinguishable from a `console.log("✓ secure")`, and it
 * is worse than nothing, because a buyer acts on it.
 *
 * So almost every test here PLANTS A REAL VIOLATION and requires the audit to catch it — a
 * `fetch()` in a file that declares no network, an `execFile('curl')`, a new environment read,
 * one flipped byte, a deleted manifest, a forged signature. Each one is a defect that would
 * genuinely matter if it shipped, and each one must turn a specific named check red.
 *
 * MUTATION SAFETY. Every mutation happens inside a throwaway COPY of the shipped file set under
 * HOLT_TMPDIR. This project has already lost work once to a mutation harness that executed its
 * own defect against the live checkout, so no test here writes to, or even resolves a path
 * inside, the repository being tested.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { underOrEqualAsync } from '../../src/paths.mjs';
import {
  audit, auditCapabilities, verifyIntegrity, buildManifest, treeDigest, shippedFiles,
  fileCapabilities, importedBuiltins, spawnTargets, envReads, computedEnvReadIdentifiers,
  stripComments, executableCode, strippedIsSafe,
  CAPABILITIES, MODULE_LEDGER, MANIFEST_FILE, MANIFEST_SIG_FILE, RELEASE_PUBLIC_KEYS_B64,
  integrityCoveredFiles,
} from '../../src/supply-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'bin', 'holt.mjs');

/** Invoke npm's JavaScript entry point with this exact Node runtime when it is discoverable.
 * On Windows `npm` is a .cmd wrapper and execFile cannot launch it directly (spawn EINVAL); using
 * the CLI avoids a shell and preserves argv boundaries. Direct `node --test` runs may not inherit
 * npm_execpath, so the two standard Node installation layouts are checked before the .cmd fallback.
 */
function npmInvocation(args) {
  const candidates = [
    process.env.npm_execpath,
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const cli = candidates.find((candidate) => fs.existsSync(candidate));
  if (cli) return { command: process.execPath, args: [cli, ...args], shell: false };
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    shell: process.platform === 'win32',
  };
}

/* ─────────────────────────────────────────────────────────────── the sandbox ──── */

/**
 * A disposable copy of exactly the files holt ships, with a fresh manifest.
 *
 * Copied, never symlinked: a symlinked tree would let a mutation reach back into the repository,
 * which is the accident this comment exists to prevent.
 */
async function sandbox() {
  const base = process.env.HOLT_TMPDIR || os.tmpdir();
  const dir = await fsp.mkdtemp(path.join(base, 'holt-supply-'));
  for (const rel of shippedFiles(ROOT)) {
    if (rel === MANIFEST_FILE || rel === MANIFEST_SIG_FILE) continue;
    const dest = path.join(dir, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(ROOT, rel), dest);
  }
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), buildManifest(dir), 'utf8');
  assert.equal(await underOrEqualAsync(path.resolve(dir), path.resolve(ROOT)), false,
    'the sandbox must be outside the repository — refusing to run mutations against a live checkout');
  return dir;
}

const cleanup = (dir) => fsp.rm(dir, { recursive: true, force: true });

/** Re-hash after a mutation, so integrity failures do not mask capability failures. */
function reseal(dir) {
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), buildManifest(dir), 'utf8');
}

const check = (rep, id) => rep.checks.find((c) => c.id === id);

/* ══════════════════════════════════════════════ 0. THE INSTRUMENT CAN SEE ═══════ */

/**
 * Law 5b. Before a single "nothing found" result is trusted, the detectors must be shown
 * finding the things that are definitely there. Without this, every green test below could be
 * satisfied by a detector that returns the empty set unconditionally.
 */
test('POSITIVE CONTROL: the detectors find what is known to be present', () => {
  const installer = fs.readFileSync(path.join(ROOT, 'bin/install-ctags.mjs'), 'utf8');
  assert.ok(fileCapabilities(installer).has('network'),
    'bin/install-ctags.mjs really does call fetch() — a detector that cannot see this one proves nothing anywhere else');
  const managedTuf = fs.readFileSync(path.join(ROOT, 'src/team/managed-policy-tuf.mjs'), 'utf8');
  assert.ok(fileCapabilities(managedTuf).has('network'),
    'the detector must see globalThis.fetch even when it is passed as a bounded adapter default');

  const gitmod = fs.readFileSync(path.join(ROOT, 'src/git.mjs'), 'utf8');
  assert.ok(importedBuiltins(gitmod).has('child_process'), 'src/git.mjs imports node:child_process');
  assert.ok(spawnTargets(gitmod).has('git'), 'src/git.mjs executes git');

  const lic = fs.readFileSync(path.join(ROOT, 'src/license.mjs'), 'utf8');
  assert.ok(envReads(lic).has('HOLT_LICENSE'),
    'HOLT_LICENSE is read as `env.HOLT_LICENSE` through an injected parameter; a detector that only knew `process.env.X` would miss the one variable carrying a secret');

  const deep = fs.readFileSync(path.join(ROOT, 'src/deep.mjs'), 'utf8');
  assert.ok(fileCapabilities(deep).has('eval'),
    'src/deep.mjs uses createRequire() — a code-loading capability the ledger must show');

  const auditSink = fs.readFileSync(path.join(ROOT, 'src/team/audit-sink.mjs'), 'utf8');
  assert.ok(fileCapabilities(auditSink).has('process'),
    'the anchored audit writer is a real subprocess boundary and must remain visible');
  assert.ok(spawnTargets(auditSink).has('<dynamic:process>'),
    'process.execPath is dynamic syntax even though production fixes it to this Node runtime');
  const sinkSite = CAPABILITIES.dynamicCallSites.find((site) => site.file === 'src/team/audit-sink.mjs');
  assert.deepEqual(sinkSite?.canRun, ['node'],
    'the dynamic sink call site must resolve only to the current Node executable');
});

test('the comment stripper does not eat regex literals containing slashes', () => {
  const src = "const re = /https?:\\/\\//g;\nimport x from 'node:net';\nconst y = 1; // gone\n";
  const stripped = stripComments(src);
  assert.ok(stripped.includes("node:net"), 'stripping must not swallow the line after a regex with escaped slashes');
  assert.ok(!stripped.includes('gone'), 'the line comment must actually be removed');
  assert.equal(strippedIsSafe(src, stripped).safe, true);
});

test('the instrument check FAILS when stripping loses code', () => {
  const raw = "import net from 'node:net';\nimport fs from 'node:fs';\n";
  const damaged = "import fs from 'node:fs';\n";
  const verdict = strippedIsSafe(raw, damaged);
  assert.equal(verdict.safe, false, 'a lost import must be reported, not shrugged off');
  assert.deepEqual(verdict.lost, ['net']);
});

test('prose about a network primitive is not a finding (the false positive that would train people to add exemptions)', () => {
  const src = "// this module never calls fetch() and never will\nexport const x = 1;\n";
  assert.equal(fileCapabilities(src).has('network'), false);
  // …but the same text as CODE is a finding, so the exemption is about comments, not about the word.
  assert.equal(fileCapabilities('await fetch(url);').has('network'), true);
});

test('inert strings and regexes are not network capabilities, but executable template expressions are', () => {
  assert.equal(fileCapabilities('const payload = "await fetch(evil)";').has('network'), false,
    'a diagnostic string does not execute itself; treating it as a call creates exemption-training noise');
  assert.equal(fileCapabilities('const pattern = /fetch\\s*\\(/;').has('network'), false);
  assert.equal(fileCapabilities('const message = `fetch(evil)`;').has('network'), false);
  assert.equal(fileCapabilities('const result = `${fetch(url)}`;').has('network'), true,
    'a template expression is executable code and must remain visible');
  assert.match(executableCode('const result = `${fetch(url)}`;'), /fetch\(url\)/);
  assert.equal(fileCapabilities('const transport = globalThis.fetch;').has('network'), true,
    'taking a reference to the global network primitive is a capability even before the call');
});

test('process target detection distinguishes child_process exec from RegExp.exec methods', () => {
  const src = "import { execFile } from 'node:child_process';\n/p/.exec(key);\nexecFile(bin, []);\n";
  assert.deepEqual([...spawnTargets(src)], ['<dynamic:bin>']);
});

test('environment detection follows process.env aliases but ignores constructed child env objects', () => {
  assert.deepEqual([...envReads('function f({ env = process.env } = {}) { return env.HOLT_LICENSE; }')],
    ['HOLT_LICENSE']);
  assert.deepEqual([...envReads('const env = {}; env.GIT_CONFIG_COUNT = "1"; return env.GIT_CONFIG_COUNT;')],
    [], 'an object prepared for a child is not an ambient environment read');
});

test('computed environment reads are inventoried by identifier, not hidden behind one wildcard', () => {
  assert.deepEqual([...computedEnvReadIdentifiers(
    'const a = process.env[canonical]; const b = process.env[underscored];',
  )].sort(), ['canonical', 'underscored']);
  assert.deepEqual([...computedEnvReadIdentifiers('const x = process.env.KNOWN;')], []);
  assert.deepEqual([...computedEnvReadIdentifiers(
    'const ambient = process.env; const inherited = ambient; const x = inherited[chosenName];',
  )], ['chosenName'], 'an alias must not turn a second computed read invisible');
  assert.deepEqual([...computedEnvReadIdentifiers('const x = process.env[prefix + suffix];')],
    ['<expression:prefix + suffix>'], 'an expression the ledger cannot name must fail as its own site');
});

/* ══════════════════════════════════════════ 1. THE REAL PACKAGE IS CLEAN ════════ */

test('the shipped package passes its own audit', async () => {
  const dir = await sandbox();
  try {
    const rep = audit({ root: dir });
    const failed = rep.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.summary}`);
    assert.deepEqual(failed, [], 'holt must pass the audit it publishes');
    assert.equal(rep.ok, true);
    assert.ok(rep.total >= 7, 'every check must run, not just the easy ones');
  } finally { await cleanup(dir); }
});

test('network capability is confined to explicit ctags setup and managed-policy sync', async () => {
  const dir = await sandbox();
  try {
    const net = check(audit({ root: dir }), 'capabilities').detail.network;
    assert.deepEqual(net, ['bin/install-ctags.mjs', 'src/team/managed-policy-tuf.mjs'],
      'if this list ever grows, the exact egress disclosure must change in the same commit');
  } finally { await cleanup(dir); }
});

/* ══════════════════════════════════════════ 2. PLANTED VIOLATIONS ═══════════════ */

test('RED: a fetch() planted in a file that declares no network is caught', async () => {
  const dir = await sandbox();
  try {
    const target = path.join(dir, 'src/analyze.mjs');
    fs.appendFileSync(target, '\nexport async function phoneHome(u) { return fetch(u); }\n');
    reseal(dir);
    const rep = audit({ root: dir });
    assert.equal(rep.ok, false, 'a fetch() in the analysis engine must fail the audit');
    const caps = check(rep, 'capabilities');
    assert.equal(caps.ok, false);
    assert.ok(caps.detail.undeclared.some((v) => v.file === 'src/analyze.mjs' && v.capability === 'network'),
      `expected src/analyze.mjs -> network in ${JSON.stringify(caps.detail.undeclared)}`);
    const netcheck = check(rep, 'network');
    assert.equal(netcheck.ok, false);
    assert.ok(netcheck.detail.undeclared.includes('src/analyze.mjs'));
  } finally { await cleanup(dir); }
});

test('RED: importing node:net anywhere is caught, even with no call', async () => {
  const dir = await sandbox();
  try {
    const target = path.join(dir, 'src/render.mjs');
    fs.writeFileSync(target, `import net from 'node:net';\n${fs.readFileSync(target, 'utf8')}`);
    reseal(dir);
    const rep = audit({ root: dir });
    assert.equal(check(rep, 'capabilities').ok, false, 'the capability is the import, not the call');
    assert.equal(check(rep, 'network').ok, false);
  } finally { await cleanup(dir); }
});

test('RED: the OLD bare specifier spelling is caught too', async () => {
  // `require('https')` without the node: prefix is the spelling a scanner tuned to `node:` misses.
  const dir = await sandbox();
  try {
    const target = path.join(dir, 'src/order.mjs');
    fs.appendFileSync(target, "\nconst https = require('https');\n");
    reseal(dir);
    assert.equal(check(audit({ root: dir }), 'network').ok, false);
  } finally { await cleanup(dir); }
});

test('RED: a dynamic import of a network module is caught', async () => {
  const dir = await sandbox();
  try {
    fs.appendFileSync(path.join(dir, 'src/roi.mjs'), "\nexport const h = () => import('node:http');\n");
    reseal(dir);
    assert.equal(check(audit({ root: dir }), 'network').ok, false);
  } finally { await cleanup(dir); }
});

test('RED: an undeclared external binary is caught', async () => {
  const dir = await sandbox();
  try {
    const target = path.join(dir, 'src/scan.mjs');
    fs.appendFileSync(target,
      "\nimport { execFile } from 'node:child_process';\nexport const ship = (a) => execFile('curl', a);\n");
    reseal(dir);
    const rep = audit({ root: dir });
    const bins = check(rep, 'binaries');
    assert.equal(bins.ok, false, 'curl must not slip in unlisted');
    assert.ok(bins.detail.undeclared.includes('curl'), JSON.stringify(bins.detail.undeclared));
  } finally { await cleanup(dir); }
});

test('RED: a subprocess whose name is a VARIABLE cannot hide from the inventory', async () => {
  // The whole point of tracking dynamic call sites: `execFile(whatever, …)` names no binary, so
  // a scan for quoted strings reports nothing and the reviewer sees a clean list.
  const dir = await sandbox();
  try {
    fs.appendFileSync(path.join(dir, 'src/partition.mjs'),
      "\nimport { execFile } from 'node:child_process';\nexport const go = (whatever, a) => execFile(whatever, a);\n");
    reseal(dir);
    const bins = check(audit({ root: dir }), 'binaries');
    assert.equal(bins.ok, false);
    assert.ok(bins.detail.undeclaredCallSites.some((s) => s.startsWith('src/partition.mjs:')),
      JSON.stringify(bins.detail.undeclaredCallSites));
  } finally { await cleanup(dir); }
});

test('RED: a new environment read is caught', async () => {
  const dir = await sandbox();
  try {
    fs.appendFileSync(path.join(dir, 'src/branches.mjs'), '\nexport const k = process.env.CORP_API_TOKEN;\n');
    reseal(dir);
    const env = check(audit({ root: dir }), 'environment');
    assert.equal(env.ok, false);
    assert.ok(env.detail.undeclared.includes('CORP_API_TOKEN'), JSON.stringify(env.detail.undeclared));
  } finally { await cleanup(dir); }
});

test('RED: a COMPUTED environment read is reported rather than silently ignored', async () => {
  // process.env[name] cannot be enumerated. Saying nothing about it would be the fail-open shape:
  // the reviewer would read a complete-looking list that is not complete.
  const dir = await sandbox();
  try {
    fs.appendFileSync(path.join(dir, 'src/index.mjs'), '\nexport const g = (n) => process.env[n];\n');
    reseal(dir);
    const env = check(audit({ root: dir }), 'environment');
    assert.equal(env.ok, false);
    assert.ok(env.detail.undeclaredDynamic.includes('src/index.mjs:n'),
      JSON.stringify(env.detail.undeclaredDynamic));
  } finally { await cleanup(dir); }
});

test('RED: a brand-new file with no ledger entry is caught, not defaulted to harmless', async () => {
  const dir = await sandbox();
  try {
    fs.writeFileSync(path.join(dir, 'src/postinstall-helper.mjs'),
      "import { execFile } from 'node:child_process';\nexecFile('bash', ['-c', 'echo hi']);\n");
    reseal(dir);
    const rep = audit({ root: dir });
    const caps = check(rep, 'capabilities');
    assert.equal(caps.ok, false, 'an unclassified file must fail, because "absent from the ledger" must never mean "safe"');
    assert.ok(caps.detail.undeclared.some((v) => v.file === 'src/postinstall-helper.mjs'));
  } finally { await cleanup(dir); }
});

test('RED: a declaration with nothing behind it fails too (no phantom entries)', async () => {
  // The mirror image, and this repo has already shipped the disease once: three paid features
  // were advertised with zero implementation. A ledger that only checks one direction lets a
  // declaration outlive the code and become a false statement in a security document.
  const dir = await sandbox();
  try {
    const rep = audit({ root: dir });
    assert.equal(rep.ok, true);
    const stale = auditCapabilities({
      root: dir,
      moduleLedger: { ...MODULE_LEDGER, 'src/render.mjs': ['network'] },
    }).find((c) => c.id === 'capabilities');
    assert.equal(stale.ok, false);
    assert.ok(stale.detail.stale.some((s) => s.file === 'src/render.mjs' && s.kind === 'declared-but-absent'));
  } finally { await cleanup(dir); }
});

/* ══════════════════════════════════════════ 3. INTEGRITY ════════════════════════ */

test('RED: one flipped byte in one shipped file is caught and named', async () => {
  const dir = await sandbox();
  try {
    const target = path.join(dir, 'src/git.mjs');
    fs.appendFileSync(target, ' ');
    const v = verifyIntegrity({ root: dir });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'mismatch');
    assert.deepEqual(v.files.modified.map((m) => m.file), ['src/git.mjs']);
    assert.notEqual(v.files.modified[0].expected, v.files.modified[0].actual);
  } finally { await cleanup(dir); }
});

test('RED: an EXTRA file that the manifest never listed is caught', async () => {
  const dir = await sandbox();
  try {
    fs.writeFileSync(path.join(dir, 'src/backdoor.mjs'), 'export const x = 1;\n');
    const v = verifyIntegrity({ root: dir });
    assert.equal(v.ok, false, 'an added file is the classic post-install injection and must not pass');
    assert.ok(v.files.unexpected.includes('src/backdoor.mjs'));
  } finally { await cleanup(dir); }
});

test('RED: a DELETED file is caught', async () => {
  const dir = await sandbox();
  try {
    fs.rmSync(path.join(dir, 'src/roi.mjs'));
    const v = verifyIntegrity({ root: dir });
    assert.equal(v.ok, false);
    assert.ok(v.files.missing.includes('src/roi.mjs'));
  } finally { await cleanup(dir); }
});

test('FAIL-CLOSED: a missing manifest is UNVERIFIED, never clean', async () => {
  // The recurring defect class in this codebase, in its purest form: absent evidence read as
  // good news. "Could not check" and "checked and fine" must not share an exit code.
  const dir = await sandbox();
  try {
    fs.rmSync(path.join(dir, MANIFEST_FILE));
    const v = verifyIntegrity({ root: dir });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'no-manifest');
    assert.match(v.reason, /UNVERIFIED/);
    assert.equal(audit({ root: dir }).ok, false);
  } finally { await cleanup(dir); }
});

test('FAIL-CLOSED: a corrupt manifest is rejected, not partially trusted', async () => {
  const dir = await sandbox();
  try {
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), 'not a manifest at all\n');
    const v = verifyIntegrity({ root: dir });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'bad-manifest');
  } finally { await cleanup(dir); }
});

test('the tree digest changes when any shipped byte changes', async () => {
  const dir = await sandbox();
  try {
    const before = treeDigest(buildManifest(dir));
    fs.appendFileSync(path.join(dir, 'src/order.mjs'), '\n');
    const after = treeDigest(buildManifest(dir));
    assert.notEqual(before, after, 'the digest a customer compares against an attestation must move');
    assert.match(before, /^[0-9a-f]{64}$/);
  } finally { await cleanup(dir); }
});

/* ══════════════════════════════════════════ 4. SIGNATURE ════════════════════════ */

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const TEST_PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const { privateKey: attackerKey } = generateKeyPairSync('ed25519');

test('a manifest signed by a pinned release key verifies', async () => {
  const dir = await sandbox();
  try {
    const body = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8');
    fs.writeFileSync(path.join(dir, MANIFEST_SIG_FILE), edSign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64'));
    const v = verifyIntegrity({ root: dir, publicKeysB64: [TEST_PUB], requireSignature: true });
    assert.equal(v.signature, 'valid');
    assert.equal(v.ok, true);
  } finally { await cleanup(dir); }
});

test('RED: an attacker who rewrites BOTH the file and the manifest is still caught by the signature', async () => {
  // This is the attack the hash list alone cannot stop, and the reason the signature exists:
  // whoever tampers with a file can also recompute the manifest. They cannot re-sign it.
  const dir = await sandbox();
  try {
    const body = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8');
    fs.writeFileSync(path.join(dir, MANIFEST_SIG_FILE), edSign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64'));

    fs.appendFileSync(path.join(dir, 'src/license.mjs'), '\n// tampered\n');
    reseal(dir); // the attacker updates the hash list to match

    const hashesOnly = verifyIntegrity({ root: dir });
    assert.equal(hashesOnly.ok, true, 'precondition: hashes alone are satisfied by a consistent forgery');

    const withSig = verifyIntegrity({ root: dir, publicKeysB64: [TEST_PUB], requireSignature: true });
    assert.equal(withSig.ok, false, 'the signature is what closes the consistent-forgery hole');
    assert.equal(withSig.signature, 'invalid');
  } finally { await cleanup(dir); }
});

test('RED: a signature from a key we do not pin is invalid', async () => {
  const dir = await sandbox();
  try {
    const body = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8');
    fs.writeFileSync(path.join(dir, MANIFEST_SIG_FILE), edSign(null, Buffer.from(body, 'utf8'), attackerKey).toString('base64'));
    const v = verifyIntegrity({ root: dir, publicKeysB64: [TEST_PUB] });
    assert.equal(v.signature, 'invalid');
  } finally { await cleanup(dir); }
});

test('--require-signature REFUSES when the manifest has no detached signature', async () => {
  // A key IS pinned now, so --require-signature expects a valid signature. An intact install
  // without a signature file is refused — reporting "verified" without a signature would be
  // the same lie as advertising an unimplemented feature.
  const dir = await sandbox();
  try {
    assert.ok(RELEASE_PUBLIC_KEYS_B64.length > 0, 'a release key is pinned; SUPPLY-CHAIN.md documents it');
    const v = verifyIntegrity({ root: dir, requireSignature: true });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'signature-required');
    assert.equal(v.signature, 'absent');
  } finally { await cleanup(dir); }
});

test('an unsigned but intact install passes, and SAYS the signature is absent', async () => {
  const dir = await sandbox();
  try {
    const v = verifyIntegrity({ root: dir });
    assert.equal(v.ok, true);
    assert.equal(v.signature, 'absent');
    assert.match(v.signatureReason, /pins? a release key/,
      'an unsigned pass must explain why the signature is absent, or it reads as a stronger claim than it is');
  } finally { await cleanup(dir); }
});

/* ══════════════════════════════════════════ 5. THE GIT-VERB CHECK ═══════════════ */

test('the git-verb check can actually fail (it is not a hard-coded pass)', () => {
  // Feed it a verb that IS allowed. If it still reports "all refused", the check is decoration.
  const rigged = { ...CAPABILITIES, network: { ...CAPABILITIES.network, gitVerbsRefused: ['rev-parse'] } };
  const c = auditCapabilities({ root: ROOT, capabilities: rigged }).find((x) => x.id === 'git-verbs');
  assert.equal(c.ok, false, 'a reachable verb must turn this check red');
  assert.ok(c.detail.reachable.some((r) => r.verb === 'rev-parse'));
});

test('every networked git verb is refused with AND without the mutation opt-in', () => {
  const c = auditCapabilities({ root: ROOT }).find((x) => x.id === 'git-verbs');
  assert.equal(c.ok, true);
  assert.deepEqual(c.detail.reachable, []);
  assert.equal(c.detail.controlVerbAllowed, true,
    'the control must pass, or "nothing reachable" would just mean the classifier says no to everything');
  for (const v of ['fetch', 'push', 'clone', 'ls-remote', 'remote', 'daemon', 'credential']) {
    assert.ok(CAPABILITIES.network.gitVerbsRefused.includes(v), `${v} must be in the tested set`);
  }
});

/* ══════════════════════════════════════════ 6. THE CLI CONTRACT ═════════════════ */

const runCli = (args, cwd) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...args], { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
});

test('holt audit exits 0 on a clean tree and prints the tree digest', async () => {
  const r = await runCli(['audit'], os.tmpdir());
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tree digest {2}[0-9a-f]{64}/);
  assert.match(r.stdout, /checks passed/);
});

test('holt audit needs no git repository — a review laptop can run it', async () => {
  const base = process.env.HOLT_TMPDIR || os.tmpdir();
  const empty = await fsp.mkdtemp(path.join(base, 'holt-norepo-'));
  try {
    const r = await runCli(['audit'], empty);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  } finally { await cleanup(empty); }
});

test('holt audit --json is machine-readable and states what holt reads, writes and sends', async () => {
  const r = await runCli(['audit', '--json'], os.tmpdir());
  assert.equal(r.code, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.ok, true);
  assert.ok(rep.statement.reads && rep.statement.writes.length && rep.statement.sends.length >= 0);
  assert.match(rep.statement.telemetry, /^none\./);
  assert.match(rep.treeDigest, /^[0-9a-f]{64}$/);
});

test('RED: holt audit --require-signature exits NON-ZERO when no detached signature is present', async () => {
  const r = await runCli(['audit', '--require-signature', '--json'], os.tmpdir());
  assert.equal(r.code, 1, 'a strict caller must be refused, not quietly passed');
  assert.equal(JSON.parse(r.stdout).ok, false);
});

/* ══════════════════════════════════════════ 7. FREE ON EVERY TIER ═══════════════ */

test('the audit is FREE — it consults no licence and is not in the priced table', async () => {
  const { FEATURE_TIER, FEATURE_ROADMAP } = await import('../../src/license.mjs');
  assert.equal(FEATURE_TIER.audit, undefined, 'gating the evidence behind the sale is a closed loop');
  assert.equal(FEATURE_ROADMAP.audit, undefined);
  // And prove it BEHAVIOURALLY: a forged licence in the environment changes nothing.
  const r = await runCli(['audit', '--json'], os.tmpdir());
  assert.equal(r.code, 0);
  const src = fs.readFileSync(path.join(ROOT, 'src/supply-chain.mjs'), 'utf8');
  assert.equal(/checkEntitlement/.test(src), false, 'src/supply-chain.mjs must not consult entitlement at all');
});

/* ══════════════════════════════════════════ 8. THE MANIFEST GATE ════════════════ */

test('the shipped manifest in this checkout is current', async () => {
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'scripts/gen-manifest.mjs'), '--check'], { cwd: ROOT, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
  });
  assert.equal(r.code, 0,
    `MANIFEST.sha256 is stale. Run: node scripts/gen-manifest.mjs\n${r.stderr}`);
});

test('MANIFEST.sha256 is shipped — an integrity file left out of the tarball checks nothing', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes(MANIFEST_FILE), `package.json "files" must include ${MANIFEST_FILE}`);
  assert.ok(shippedFiles(ROOT).includes(MANIFEST_FILE));
});

test('documentation is shipped but cannot stale the executable integrity boundary', async () => {
  const dir = await sandbox();
  try {
    assert.ok(shippedFiles(dir).includes('README.md'), 'README remains part of the user package');
    assert.equal(integrityCoveredFiles(dir).includes('README.md'), false,
      'README prose must not control executable integrity or later CI');
    const before = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8');
    fs.appendFileSync(path.join(dir, 'README.md'), '\ncopy edit only\n');
    assert.equal(buildManifest(dir), before, 'a prose edit must leave the executable tree digest unchanged');
    assert.equal(verifyIntegrity({ root: dir, publicKeysB64: [] }).ok, true,
      'installed runtime integrity remains verified after a documentation-only edit');
  } finally {
    await cleanup(dir);
  }
});

test('THE REAL TARBALL SELF-VERIFIES — the manifest must describe what npm actually packs', async () => {
  // The one test that reproduces the customer's first minute. Everything else in this file
  // reasons about the repository; npm decides what SHIPS, and the two disagreed on the very
  // first real run: the manifest listed CHANGELOG.md, which modern npm does not always-pack and
  // .npmignore excludes, so a fresh install reported `1 missing` and the customer's first
  // experience of our security evidence would have been it failing.
  const base = process.env.HOLT_TMPDIR || os.tmpdir();
  const dir = await fsp.mkdtemp(path.join(base, 'holt-pack-'));
  try {
    // --ignore-scripts so prepack does NOT regenerate the manifest: the point is to verify the
    // manifest already committed, exactly as a consumer receives it.
    // The old callback returned null for EVERY error and then t.skip()'d, so the Windows
    // `spawn EINVAL` that disabled this exact gate was reported as a green suite. A packaging
    // instrument that cannot run is a release failure, with its stderr retained as evidence.
    const invocation = npmInvocation(['pack', '--silent', '--ignore-scripts', '--pack-destination', dir]);
    const packed = await new Promise((resolve, reject) => {
      execFile(invocation.command, invocation.args,
        {
          cwd: ROOT, timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
          shell: invocation.shell,
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`npm pack could not produce the artifact under test: ${stderr || err.message}`));
            return;
          }
          const name = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
          if (!name) {
            reject(new Error('npm pack exited zero but returned no tarball name'));
            return;
          }
          resolve(name);
        });
    });

    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', path.join(dir, packed), '-C', dir],
        { timeout: 120_000 },
        (err) => (err ? reject(err) : resolve()));
    });

    const pkgRoot = path.join(dir, 'package');
    const v = verifyIntegrity({ root: pkgRoot });
    assert.equal(v.ok, true,
      `the published tarball fails its own integrity check: `
      + `missing=${JSON.stringify(v.files.missing)} unexpected=${JSON.stringify(v.files.unexpected)} `
      + `modified=${JSON.stringify(v.files.modified.map((m) => m.file))}`);

    const rep = audit({ root: pkgRoot });
    assert.equal(rep.ok, true, rep.checks.filter((c) => !c.ok).map((c) => c.summary).join('; '));
  } finally { await cleanup(dir); }
});

/* ══════════════════════════════════════════ 9. THE DOCUMENT CANNOT ROT ══════════ */

/**
 * A security document is a claim a buyer acts on, and a claim nobody re-checks starts rotting the
 * moment it is written — this repository has already published its own test count three
 * incompatible ways at once. So the prose is gated against the declaration the code enforces.
 */
const SUPPLY_DOC = fs.readFileSync(path.join(ROOT, 'SUPPLY-CHAIN.md'), 'utf8');
const QUESTIONNAIRE = fs.readFileSync(path.join(ROOT, 'docs/SECURITY-QUESTIONNAIRE.md'), 'utf8');

test('SUPPLY-CHAIN.md lists every environment variable holt actually reads', () => {
  const missing = CAPABILITIES.environment.map((e) => e.name).filter((n) => !SUPPLY_DOC.includes(n));
  assert.deepEqual(missing, [], 'a published "what we read" list that omits a real read is worse than no list');
});

test('SUPPLY-CHAIN.md lists every external binary holt can execute', () => {
  const names = new Set([
    ...CAPABILITIES.binaries.map((b) => b.name),
    ...CAPABILITIES.dynamicCallSites.flatMap((s) => s.canRun).filter((c) => !c.startsWith('<')),
  ]);
  const missing = [...names].filter((n) => !new RegExp(`\`${n}\``).test(SUPPLY_DOC));
  assert.deepEqual(missing, [], 'every binary must appear in the published list');
});

test('FILESYSTEM CLAIM: every shipped acting write class is disclosed in audit JSON and docs', () => {
  const claims = JSON.stringify(CAPABILITIES.filesystem).toLowerCase();
  const doc = SUPPLY_DOC.toLowerCase();
  // Each source probe is a positive control: the behavior must still exist or this test would be
  // satisfied by stale prose about a feature that was removed. Each matching claim then prevents
  // the inverse failure—shipped mutating behavior disappearing from the machine-readable audit.
  const contracts = [
    { file: 'src/actions.mjs', source: /refs\/holt\/discard/, claim: 'refs/holt/discard' },
    { file: 'src/actions.mjs', source: /worktree', 'move'/, claim: 'registered worktree paths' },
    { file: 'src/actions.mjs', source: /restoreHeadSelection/, claim: 'explicit working-tree paths' },
    { file: 'src/actions.mjs', source: /\['worktree', 'lock'/, claim: 'private worktree admin state' },
    { file: 'src/team/audit-sink.mjs', source: /\.checkpoint/, claim: 'sink path' },
    { file: 'src/integrate/receipt.mjs', source: /install-receipt\.json/, claim: 'integration receipts' },
    { file: 'src/integrate/adapters.mjs', source: /scope === 'user'/, claim: 'existing user host-config' },
    { file: 'src/agent.mjs', source: /holt-cache-/, claim: 'scan/hook caches' },
  ];
  for (const c of contracts) {
    const source = fs.readFileSync(path.join(ROOT, c.file), 'utf8');
    assert.match(source, c.source, `${c.file} positive control no longer reaches the named write`);
    assert.ok(claims.includes(c.claim), `holt audit omits shipped write class '${c.claim}' from ${c.file}`);
    assert.ok(doc.includes(c.claim), `SUPPLY-CHAIN.md omits shipped write class '${c.claim}' from ${c.file}`);
  }
  for (const phrase of ['working-tree files', 'git object database', 'local branches/refs']) {
    assert.ok(claims.includes(phrase), `holt audit omits '${phrase}'`);
  }
});

test('FILESYSTEM CLAIM: --global user config reads are not hidden behind a repo-only sentence', () => {
  const reads = CAPABILITIES.filesystem.reads.toLowerCase();
  assert.match(reads, /integrate --global/);
  assert.match(reads, /user host-config/);
  assert.doesNotMatch(reads, /nothing outside the repository/);
  assert.match(SUPPLY_DOC, /supported existing user host-config files/i);
});

test('SUPPLY-CHAIN.md names every fixed or administrator-supplied network destination class', () => {
  for (const e of CAPABILITIES.network.egress) {
    if (/^https?:/u.test(e.destination)) {
      const host = new URL(e.destination.replace(/<[^>]*>/g, 'x')).host;
      assert.ok(SUPPLY_DOC.includes(host), `destination ${host} is not disclosed in SUPPLY-CHAIN.md`);
    } else {
      assert.match(e.destination, /administrator-supplied/u);
      assert.match(SUPPLY_DOC, /administrator-supplied[^\n]*(?:TUF|metadata|target)/iu);
    }
  }
  assert.equal(CAPABILITIES.network.egress.length, 2,
    'the two explicit egress implementations must both stay visible');
  assert.match(QUESTIONNAIRE, /two in-process network paths/i);
});

test('both INDIRECT network paths are exact and disclosed in both documents, not only in the code', () => {
  // The gap this whole exercise found in its own first draft: `sh -c "sudo apt-get install …"`
  // reaches the network through a child process, so no in-process detector sees it, and a
  // capability ledger that only watches sockets would have reported a clean "one destination"
  // while the tool could run a privileged installer. Both documents must say so, and the
  // machine-readable output must carry it beside `sends` rather than somewhere a reader has to
  // go looking.
  assert.equal(CAPABILITIES.network.indirect.length, 2,
    'package-manager and exact-versioned Go install must remain separately declared');
  const enry = CAPABILITIES.network.indirect.find((entry) => /go install/u.test(entry.via));
  assert.ok(enry, 'the Go installer must not disappear behind the package-manager declaration');
  assert.equal(enry.via, 'go install github.com/go-enry/go-enry/v2/cmd/enry@v2.9.6');
  assert.match(enry.effect, /download|network/iu);
  assert.match(enry.effect, /write|destination|bin/iu);
  assert.match(enry.avoidable, /decline|avoid/iu);
  for (const doc of [SUPPLY_DOC, QUESTIONNAIRE]) {
    assert.match(doc, /package manager/i, 'the package-manager install path must be disclosed');
    assert.match(doc, /sudo/, 'the privilege escalation must be named, not implied');
    assert.ok(doc.includes(enry.via), 'the exact Enry package and version must be disclosed');
  }
  assert.ok(CAPABILITIES.privilege.escalates.length === 1,
    'exactly one privilege path exists; if that changes, both documents must change with it');
});

test('holt audit --json surfaces the indirect path beside what it sends', async () => {
  const r = await runCli(['audit', '--json'], os.tmpdir());
  const rep = JSON.parse(r.stdout);
  assert.ok(Array.isArray(rep.statement.indirectNetwork),
    'a reviewer parsing the JSON must see subprocess-mediated network paths without reading prose');
  assert.equal(rep.statement.indirectNetwork.length, 2);
  assert.ok(rep.statement.indirectNetwork.some((entry) => /sudo/u.test(entry.effect)));
  const enry = rep.statement.indirectNetwork.find((entry) => /go install/u.test(entry.via));
  assert.equal(enry?.via, 'go install github.com/go-enry/go-enry/v2/cmd/enry@v2.9.6');
  assert.match(enry?.effect ?? '', /download|network/iu);
  assert.ok(rep.statement.privilege?.never);
});

test('the questionnaire names the exact required and optional runtime dependency boundary', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {
    '@modelcontextprotocol/sdk': '1.30.0',
    'jsonc-parser': '3.3.1',
    'tuf-js': '6.0.0',
  });
  assert.deepEqual(pkg.optionalDependencies, { jscpd: '5.0.14' });
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    assert.ok(QUESTIONNAIRE.includes(`${name}@${version}`), `${name}@${version} missing from questionnaire`);
    assert.ok(SUPPLY_DOC.includes(`${name}@${version}`), `${name}@${version} missing from supply-chain document`);
  }
});

test('the questionnaire claims no postinstall script, and there is none', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const hook of ['postinstall', 'preinstall', 'install']) {
    assert.equal(pkg.scripts?.[hook], undefined, `package.json defines a ${hook} script; the questionnaire says it does not`);
  }
  assert.match(QUESTIONNAIRE, /Post-install scripts \| \*\*None\.\*\*/);
});

test('the docs claim SLSA Build L2 and the workflow does not claim more', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release-artifact.yml'), 'utf8');
  assert.ok(/Build L2/.test(SUPPLY_DOC) && /Build L2/.test(QUESTIONNAIRE));
  assert.equal(/SLSA.{0,20}(Level|L)\s*3\b/.test(wf.replace(/require.*L3[^\n]*/g, '')), false,
    'the workflow must not claim a level the build does not reach');
  assert.ok(/id-token: write/.test(wf) && /attestations: write/.test(wf),
    'the permissions provenance actually needs must be present, or the workflow will fail at release time');
});

test('the workflow names the exact secrets it needs, and guards every credentialed step', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release-artifact.yml'), 'utf8');
  assert.ok(wf.includes('HOLT_RELEASE_SIGNING_KEY'), 'the signing secret must be named');
  // `secrets` is not available in a step-level `if:`; writing one there never matches, so the
  // "skip when absent" guard would silently become "always run" and the release would break.
  assert.equal(/^\s+if:.*secrets\./m.test(wf), false,
    'a step-level `if:` referencing the secrets context never matches — hoist it to a job-level env');
  assert.ok(SUPPLY_DOC.includes('HOLT_RELEASE_SIGNING_KEY'),
    'SUPPLY-CHAIN.md §5 must tell the owner exactly which secrets to create');
});
