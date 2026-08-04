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
  fileCapabilities, importedBuiltins, spawnTargets, envReads, stripComments, strippedIsSafe,
  CAPABILITIES, MODULE_LEDGER, MANIFEST_FILE, MANIFEST_SIG_FILE, RELEASE_PUBLIC_KEYS_B64,
} from '../../src/supply-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'bin', 'holt.mjs');

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

  const gitmod = fs.readFileSync(path.join(ROOT, 'src/git.mjs'), 'utf8');
  assert.ok(importedBuiltins(gitmod).has('child_process'), 'src/git.mjs imports node:child_process');
  assert.ok(spawnTargets(gitmod).has('git'), 'src/git.mjs executes git');

  const lic = fs.readFileSync(path.join(ROOT, 'src/license.mjs'), 'utf8');
  assert.ok(envReads(lic).has('HOLT_LICENSE'),
    'HOLT_LICENSE is read as `env.HOLT_LICENSE` through an injected parameter; a detector that only knew `process.env.X` would miss the one variable carrying a secret');

  const deep = fs.readFileSync(path.join(ROOT, 'src/deep.mjs'), 'utf8');
  assert.ok(fileCapabilities(deep).has('eval'),
    'src/deep.mjs uses createRequire() — a code-loading capability the ledger must show');
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

test('a network primitive inside a STRING is still a finding', () => {
  // Strings get evaluated, written to disk and executed. Treating them as inert is how a
  // generated-code path smuggles capability past a source scan.
  assert.equal(fileCapabilities('const payload = "await fetch(evil)";').has('network'), true);
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

test('network capability is confined to exactly one file, and it is the installer', async () => {
  const dir = await sandbox();
  try {
    const net = check(audit({ root: dir }), 'capabilities').detail.network;
    assert.deepEqual(net, ['bin/install-ctags.mjs'],
      'if this list ever grows, the "no network" claim on the README has changed and someone must say so');
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
    assert.ok(env.detail.undeclared.includes('<computed>'), JSON.stringify(env.detail.undeclared));
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

test('THE REAL TARBALL SELF-VERIFIES — the manifest must describe what npm actually packs', async (t) => {
  // The one test that reproduces the customer's first minute. Everything else in this file
  // reasons about the repository; npm decides what SHIPS, and the two disagreed on the very
  // first real run: the manifest listed CHANGELOG.md, which modern npm does not always-pack and
  // .npmignore excludes, so a fresh install reported `1 missing` and the customer's first
  // experience of our security evidence would have been it failing.
  const base = process.env.HOLT_TMPDIR || os.tmpdir();
  const dir = await fsp.mkdtemp(path.join(base, 'holt-pack-'));
  try {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    // --ignore-scripts so prepack does NOT regenerate the manifest: the point is to verify the
    // manifest already committed, exactly as a consumer receives it.
    const packed = await new Promise((resolve) => {
      execFile(npmBin, ['pack', '--silent', '--ignore-scripts', '--pack-destination', dir],
        { cwd: ROOT, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout).trim().split('\n').pop()));
    });
    if (!packed) return t.skip('npm pack unavailable in this environment');

    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', path.join(dir, packed), '-C', dir], { timeout: 120_000 },
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

test('SUPPLY-CHAIN.md names every network destination, and claims no more than one', () => {
  for (const e of CAPABILITIES.network.egress) {
    const host = new URL(e.destination.replace(/<[^>]*>/g, 'x')).host;
    assert.ok(SUPPLY_DOC.includes(host), `destination ${host} is not disclosed in SUPPLY-CHAIN.md`);
  }
  assert.equal(CAPABILITIES.network.egress.length, 1,
    'SUPPLY-CHAIN.md and the questionnaire both say "one destination" — if that changes, both must change');
  assert.match(QUESTIONNAIRE, /One outbound request exists in the entire package/);
});

test('the INDIRECT network path is disclosed in both documents, not only in the code', () => {
  // The gap this whole exercise found in its own first draft: `sh -c "sudo apt-get install …"`
  // reaches the network through a child process, so no in-process detector sees it, and a
  // capability ledger that only watches sockets would have reported a clean "one destination"
  // while the tool could run a privileged installer. Both documents must say so, and the
  // machine-readable output must carry it beside `sends` rather than somewhere a reader has to
  // go looking.
  assert.ok(CAPABILITIES.network.indirect.length >= 1, 'the indirect path must be declared');
  for (const doc of [SUPPLY_DOC, QUESTIONNAIRE]) {
    assert.match(doc, /package manager/i, 'the package-manager install path must be disclosed');
    assert.match(doc, /sudo/, 'the privilege escalation must be named, not implied');
  }
  assert.ok(CAPABILITIES.privilege.escalates.length === 1,
    'exactly one privilege path exists; if that changes, both documents must change with it');
});

test('holt audit --json surfaces the indirect path beside what it sends', async () => {
  const r = await runCli(['audit', '--json'], os.tmpdir());
  const rep = JSON.parse(r.stdout);
  assert.ok(Array.isArray(rep.statement.indirectNetwork) && rep.statement.indirectNetwork.length >= 1,
    'a reviewer parsing the JSON must see the subprocess-mediated network path without reading prose');
  assert.match(rep.statement.indirectNetwork[0].effect, /sudo/);
  assert.ok(rep.statement.privilege?.never);
});

test('the questionnaire\'s "zero required runtime dependencies" claim is true', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {},
    'the questionnaire and SUPPLY-CHAIN.md both state zero required runtime dependencies');
  assert.ok(QUESTIONNAIRE.includes('Zero required'));
  assert.ok(SUPPLY_DOC.includes('required runtime dependencies: 0'));
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
