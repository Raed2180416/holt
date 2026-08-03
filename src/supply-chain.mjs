// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — the supply-chain audit the CUSTOMER runs, on the copy they actually installed.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT MARKETING.
 *
 * holt's README promises "no network calls, ever". Until this file existed, the only thing
 * standing behind that promise was a `grep` in OUR CI, over `src/` only — which a buyer cannot
 * run, cannot see, and could not have trusted anyway, because:
 *
 *   1. The SHIPPED PACKAGE is `bin/` + `src/`, and the CI gate only ever looked at `src/`.
 *      The single file in this project that really does open a socket — `bin/install-ctags.mjs`
 *      — sat in the half the gate did not cover. The promise was true, the instrument could
 *      not have detected it being false.
 *   2. A gate that runs in the vendor's CI proves something about the vendor's repository at
 *      some past commit. It proves nothing about the bytes on the reviewer's laptop.
 *
 * So this module is a LEDGER, not a scanner. Every capability the shipped package has —
 * every Node builtin that can touch the filesystem, spawn a process, open a socket or evaluate
 * code; every external binary it can execute; every environment variable it reads; every
 * network destination it can reach and what triggers it — is DECLARED here, and the audit
 * compares the declaration against the bytes on disk. The audit fails on a difference in either
 * direction: an undeclared capability, or a declaration with nothing behind it.
 *
 * That inversion is the whole point. A scanner's silence is ambiguous (absent, or invisible to
 * the instrument?). A ledger's silence is not: a new `import` of `node:net` anywhere in the
 * package fails the audit until a human writes down what it is for.
 *
 * WHAT IT IS NOT. This is tamper-EVIDENT, not tamper-proof, exactly like `src/license.mjs`.
 * Anyone who can edit the installed files can also edit this declaration. What it defends
 * against is the realistic threat: a dependency-confusion or post-install-script substitution
 * that changes behaviour and hopes nobody looks, and a vendor's own claim silently rotting
 * against its own code. It is not a defence against an attacker who already owns the machine.
 *
 * NO NETWORK, NO DEPENDENCIES, NO CLOCK. Everything here is a local read plus SHA-256 from
 * `node:crypto`. It must work on an air-gapped review laptop, which is precisely where the
 * question gets asked.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { classify } from './git.mjs';

/* ═══════════════════════════════════════════════════════ THE DECLARATION ══════════ */

/**
 * Node builtins that grant a capability worth declaring. Everything absent from this table
 * (`node:path`, `node:url`, `node:util`, `node:os`, `node:crypto`, `node:events`, …) computes
 * or formats and cannot reach anything, so listing it would be noise that hides the signal.
 *
 * Anything that CAN reach out is here, including the ones people forget: `node:inspector`
 * opens a debugger port, `node:module` and `node:vm` evaluate code, `node:cluster` forks.
 */
export const CAPABILITY_MODULES = {
  'child_process': 'process',
  'cluster': 'process',
  'fs': 'filesystem',
  'fs/promises': 'filesystem',
  'http': 'network',
  'https': 'network',
  'http2': 'network',
  'net': 'network',
  'tls': 'network',
  'dgram': 'network',
  'dns': 'network',
  'dns/promises': 'network',
  'inspector': 'network',
  'inspector/promises': 'network',
  'vm': 'eval',
  'module': 'eval',
  'repl': 'eval',
  'worker_threads': 'eval',
};

/** Ordered so a report reads worst-first. */
export const CAPABILITY_CLASSES = ['network', 'process', 'eval', 'filesystem'];

/**
 * WHAT HOLT READS, WRITES AND SENDS — the statement a security review asks for, in the one
 * place that is checked against the code on every run.
 *
 * `modules` is the per-file capability ledger. A file is listed with the capability CLASSES it
 * holds, not the individual imports, because the class is what a reviewer is deciding about
 * ("which parts of this tool can spawn a process?") and the import list rots on every refactor
 * while the class does not.
 */
export const CAPABILITIES = {
  /**
   * NETWORK. Exactly one file in the shipped package can reach the network, it does so only
   * when a human asks, to one pinned URL, and it refuses the result unless it matches a pinned
   * hash. `sends` is the field a reviewer actually cares about and it is the same everywhere:
   * holt has no telemetry, no analytics, no crash reporting and no licence call-home.
   */
  network: {
    egress: [
      {
        file: 'bin/install-ctags.mjs',
        api: 'fetch',
        destination: 'https://github.com/universal-ctags/ctags-nightly-build/releases/download/<pinned tag>/<pinned asset>',
        trigger: 'ONLY on an explicit human request: `holt setup`, or `holt doctor --install`. Never on import, never on a scan, never on a hook, never on an MCP call.',
        sends: 'nothing. An unauthenticated GET of a public release asset. No request body, no query string, no custom headers, no cookies, no identifiers.',
        receives: 'a ctags tarball, verified against a SHA-256 pinned in src/toolchain.mjs and REFUSED on mismatch before anything is written or executed.',
        avoidable: 'yes — install universal-ctags from your own package manager and holt never downloads anything. `holt doctor` tells you it is missing rather than fetching it.',
      },
    ],
    /**
     * The claim that survives even if you do not trust the file list: holt drives git through
     * an argv allowlist, and EVERY networked git verb is outside it. `git fetch`, `push`,
     * `pull`, `clone`, `ls-remote`, `remote`, `submodule`, `daemon`, `credential`, the
     * `http-*` helpers and the foreign-SCM bridges cannot be reached from any code path, with
     * or without the mutation opt-in. auditCapabilities() proves this by CALLING the
     * classifier, not by reading it.
     */
    gitVerbsRefused: [
      'fetch', 'push', 'pull', 'clone', 'ls-remote', 'remote', 'submodule', 'send-email',
      'request-pull', 'fetch-pack', 'upload-pack', 'upload-archive', 'receive-pack', 'daemon',
      'credential', 'credential-cache', 'credential-store', 'http-fetch', 'http-push',
      'http-backend', 'imap-send', 'p4', 'svn', 'bundle',
    ],
    telemetry: 'none. holt has no analytics, no usage reporting, no crash reporting, no update check, and no licence server call — entitlement is an offline Ed25519 signature check (src/license.mjs).',

    /**
     * INDIRECT NETWORK — a subprocess that reaches the network on your behalf.
     *
     * This section exists because writing the rest of this file was not enough. The first draft
     * declared `sh` as being used for "backend probes and `holt verify --run`" and stopped
     * there. It has a THIRD use: `holt doctor --install` composes a package-manager command,
     * prints it, requires a typed `y`, and then runs it — with `sudo` on Linux. holt opens no
     * socket doing that, so no in-process detector would ever have flagged it, and a reviewer
     * reading "one network destination" would have been misled by a true sentence.
     *
     * A capability that arrives through a child process is still a capability. An incomplete
     * disclosure in a security document is the disease this whole module was built to prevent,
     * and it appeared here first.
     */
    indirect: [
      {
        via: 'sh -c "<your package manager> install …"',
        file: 'bin/holt.mjs',
        trigger: '`holt setup` or `holt doctor --install`, and ONLY after holt prints the exact command and you answer `y` (or pass --yes)',
        effect: 'apt-get / dnf / pacman / brew / winget installs universal-ctags or ripgrep. That reaches the network, and on Linux it runs under `sudo` — holt says so on screen before asking.',
        avoidable: 'yes — install the backends yourself, or simply never pass --install. Nothing runs without the confirmation.',
      },
    ],
  },

  /**
   * PRIVILEGE. One path, and it is the same one: the package-manager install prefixes `sudo` on
   * Linux. holt never elevates silently, never elevates during analysis, and never elevates
   * without printing the full command first.
   */
  privilege: {
    escalates: ['sudo, only inside the confirmed package-manager command described in network.indirect'],
    never: 'no analysis, scan, hook, MCP call or mutating git action ever runs elevated.',
  },

  /**
   * ENVIRONMENT. Every variable the shipped package reads. Nothing here is ever transmitted:
   * there is nowhere to transmit it to (see `network`).
   */
  environment: [
    { name: 'GITHUB_HEAD_REF', why: 'detect the PR branch when running inside GitHub Actions (`holt ci`)' },
    { name: 'HOLT_CTAGS_OPTIONS', why: 'extra flags for the ctags backend' },
    { name: 'HOLT_HOME', why: 'override where holt keeps its own bin directory' },
    { name: 'HOLT_LICENSE', why: 'a licence token supplied by CI instead of a file' },
    { name: 'HOLT_TMPDIR', why: 'override the scratch directory used by the test suite and by `holt verify`' },
    { name: 'JJ_CONFIG', why: 'neutralise the user config when probing the Jujutsu backend' },
    { name: 'LOCALAPPDATA', why: 'Windows equivalent of XDG_DATA_HOME' },
    { name: 'NO_COLOR', why: 'the no-colour convention' },
    { name: 'PATH', why: 'locate optional backends (git, ctags, enry, rg, jj)' },
    { name: 'TERM', why: 'terminal capability detection for the TUI' },
    { name: 'TMPDIR', why: 'the platform scratch directory' },
    { name: 'XDG_CONFIG_HOME', why: 'where the licence file lives' },
    { name: 'XDG_DATA_HOME', why: 'where a holt-installed ctags lives' },
  ],

  /**
   * EXTERNAL BINARIES. Every process the shipped package can execute. `git` and `jj` are driven
   * through argv allowlists; the rest are read-only probes. Two entries are not fixed strings
   * and are called out as such, because a reviewer must know that holt CAN run an arbitrary
   * command — only ever one the operator typed.
   */
  binaries: [
    { name: 'git', why: 'the analysis engine', constrained: 'src/git.mjs argv allowlist — no networked verb, no history rewrite' },
    { name: 'jj', why: 'optional Jujutsu backend', constrained: 'src/jj.mjs, read-only verbs' },
    { name: 'ctags', why: 'optional symbol extraction', constrained: 'read-only' },
    { name: 'enry', why: 'optional language detection', constrained: 'read-only' },
    { name: 'rg', why: 'optional fast search for `holt impact`', constrained: 'read-only' },
    {
      name: 'sh',
      why: 'THREE uses, and the third is the one worth reading: (1) `command -v <tool>` backend probes; (2) the command YOU passed to `holt verify --run`; (3) `holt doctor --install` running your package manager — which reaches the network and uses sudo on Linux. See network.indirect.',
      constrained: 'the probe form is a fixed template; the --run form is your own string and `holt verify` documents that it executes code; the install form prints the exact command and requires a typed confirmation or --yes',
    },
    { name: 'holt', why: 'confirm the CLI is on PATH while `holt integrate` wires an agent host', constrained: '`holt --help`' },
  ],

  /**
   * CALL SITES WHERE THE BINARY IS A VARIABLE — the half of a subprocess inventory that a
   * literal-string scan cannot see, and therefore the half where something would hide.
   *
   * `jscpd` is the proof this section earns its keep: it is executed through `execFile(bin, …)`
   * with `bin` resolved at runtime, so a scan for quoted binary names reported seven binaries
   * and missed an eighth that holt genuinely runs. Every dynamic call site must be listed here
   * with what it can resolve to; an undeclared one fails the audit, and so does a declared one
   * that no longer exists.
   */
  dynamicCallSites: [
    {
      file: 'bin/install-ctags.mjs', identifier: 'cmd', canRun: ['tar'],
      why: 'a local run() wrapper; the only caller passes `tar`, to extract the ctags archive AFTER its SHA-256 was verified',
    },
    {
      file: 'src/deep.mjs', identifier: 'bin', canRun: ['jscpd'],
      why: 'the optional jscpd clone-detection backend, resolved from node_modules/.bin or PATH. Only reached by `holt duplicates --deep`',
    },
    {
      file: 'src/verify.mjs', identifier: 'cmd', canRun: ['<the command you passed to `holt verify --run`>'],
      why: 'holt verify exists to run YOUR test suite against a speculative merge. It executes code, says so in its help text, and runs nothing you did not type',
    },
    {
      file: 'src/integrate/adapters.mjs', identifier: 'HOLT_CMD', canRun: ['holt'],
      why: 'NOT executed by holt — it appears inside a template literal that GENERATES the opencode plugin file. The generated plugin invokes holt itself',
    },
  ],

  /**
   * FILESYSTEM. holt never writes to the repository it inspects — that is the core promise, it
   * is enforced in src/git.mjs and proven by test/unit/safety.test.mjs. This list is every
   * OTHER place the shipped package can write, and what puts it there.
   */
  filesystem: {
    reads: 'the git repository you point it at, plus the optional backend binaries it probes. Nothing outside the repository except its own config and cache paths below.',
    writes: [
      { scope: '$XDG_CONFIG_HOME/holt/license', by: 'holt license activate', mode: '0600, O_NOFOLLOW' },
      { scope: '$GIT_COMMON_DIR/holt/journal.jsonl', by: 'every mutating action (protect/rescue/clean/branch-delete)', mode: 'append-only JSONL, inside the repo\'s git dir, never in the working tree' },
      { scope: '$HOLT_HOME (or $XDG_DATA_HOME/holt)', by: 'holt setup — a holt-installed ctags binary', mode: 'operator-triggered' },
      { scope: 'the file path you pass to --html', by: 'holt graph --html <file>', mode: 'you named it' },
      { scope: 'a scratch directory under $TMPDIR', by: 'holt verify (a speculative merge worktree) and the jscpd backend', mode: 'created and removed by the command' },
      { scope: 'agent host config files in the repo', by: 'holt integrate', mode: 'the entire purpose of that command; it prints what it will write' },
    ],
    never: 'the working tree, index, refs, config, stash or reflog of the repository under analysis. The single exception is an UNREFERENCED git object from `merge-tree --write-tree`, which git\'s own gc reclaims, and `--strict-read-only` removes even that.',
  },
};

/* ══════════════════════════════════════════════ SHIPPED-FILE ENUMERATION ══════════ */

/**
 * Files npm always includes regardless of `files`: package.json, README, LICENCE.
 *
 * CHANGELOG is deliberately NOT here, and that was a real bug this audit caught in its own
 * first run against a real tarball. Older npm always-packed a CHANGELOG; modern npm does not,
 * and this repository's .npmignore excludes it — so the manifest listed a file the tarball did
 * not contain and `holt audit` on a fresh install reported `1 missing`. The manifest must
 * describe what npm ACTUALLY packs, and the packed-tarball test below is what keeps this
 * honest rather than this comment.
 */
const ALWAYS_PACKED = /^(package\.json|readme(\.[^.]+)?|licen[cs]e(\.[^.]+)?)$/i;

/**
 * The exact set of files this package ships, derived from package.json `files` the way npm
 * derives it. Deterministic and sorted, because it is hashed.
 *
 * Deriving it (rather than hard-coding a list) is deliberate: a hard-coded list silently stops
 * covering anything added later, which is the failure mode this whole module exists to prevent.
 */
export function shippedFiles(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = new Set();

  const addFile = (rel) => { out.add(rel.split(path.sep).join('/')); };
  const walk = (rel) => {
    const abs = path.join(root, rel);
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isFile()) return addFile(rel);
    if (!st.isDirectory()) return;
    for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name));
  };

  for (const entry of pkg.files ?? []) walk(entry);
  for (const name of fs.readdirSync(root)) {
    if (ALWAYS_PACKED.test(name) && fs.statSync(path.join(root, name)).isFile()) addFile(name);
  }
  return [...out].sort();
}

const isSource = (rel) => rel.endsWith('.mjs') || rel.endsWith('.js') || rel.endsWith('.cjs');

/* ═══════════════════════════════════════════════════════════ DETECTORS ════════════ */

/**
 * Blank out comments, preserving every other byte and every line break.
 *
 * WHY THIS IS NEEDED AND WHY IT IS DANGEROUS. `fetch`, `WebSocket` and friends are GLOBALS —
 * there is no import to key off, so they must be detected textually, and a textual detector
 * cannot tell code from the sentence describing it. Without this, the sentence four paragraphs
 * up that says "a file that calls fetch() …" would classify THIS file as network-capable. An
 * audit that cries wolf about its own prose teaches people to add exemptions, and an exemption
 * list is how a real finding eventually gets waved through.
 *
 * The danger is the `/` ambiguity: `/https?:\/\//` is a regex containing two slashes that a
 * naive stripper reads as a line comment and deletes the rest of the line — silently turning a
 * false positive problem into a false NEGATIVE one, which is far worse. So regex literals are
 * tracked using the standard previous-significant-token rule, STRINGS ARE PRESERVED (a network
 * primitive hidden in a string is still a finding — strings get evaluated), and the result is
 * checked by strippedIsSafe() below before any conclusion is drawn from it.
 */
export function stripComments(src) {
  let out = '';
  let prev = '';               // last significant character emitted
  let i = 0;
  const n = src.length;
  // After these, a `/` begins a REGEX; after anything else it is division.
  const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n', '']);
  const KEYWORD_BEFORE_REGEX = /\b(return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await)$/;

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {                       // line comment
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {                       // block comment — keep the newlines
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {          // string / template — preserved verbatim
      const quote = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      prev = quote;
      continue;
    }
    if (c === '/') {                                    // regex literal, or division
      const isRegex = REGEX_PRECEDERS.has(prev) || KEYWORD_BEFORE_REGEX.test(out.trimEnd());
      out += c; i++;
      if (isRegex) {
        let inClass = false;
        while (i < n && src[i] !== '\n') {
          if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          else if (src[i] === '/' && !inClass) { out += src[i]; i++; break; }
          out += src[i]; i++;
        }
      }
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    else if (c === '\n') prev = '\n';
    i++;
  }
  return out;
}

/**
 * Law 5b, applied to this module's own instrument: an empty result has two explanations —
 * the thing is absent, or the detector cannot see it — and they are indistinguishable from
 * the output alone.
 *
 * Every `import … from 'node:x'` sits at the top of a file, before any regex or division, so
 * stripping MUST preserve all of them. If even one disappears, the stripper desynced and ate
 * code, and every "clean" verdict computed from its output is worthless. That is reported as a
 * FAILURE, never as a pass.
 */
export function strippedIsSafe(raw, stripped) {
  // Only LINE-START import/export statements count, so a sentence in a doc comment that happens
  // to quote a specifier cannot be mistaken for lost code.
  const specs = (s) => [...s.matchAll(/^[ \t]*(?:import|export)\s[^\n]*?['"]node:([a-z_/]+)['"]/gm)].map((m) => m[1]);
  const before = specs(raw);
  const after = new Set(specs(stripped));
  const lost = [...new Set(before.filter((s) => !after.has(s)))];
  return { safe: lost.length === 0, lost };
}

/**
 * Every `node:` builtin a file imports, in any of the four spellings that reach one:
 * static import, dynamic import(), require(), and createRequire()(…).
 *
 * Bare specifiers (`'fs'`) count exactly the same as prefixed ones (`'node:fs'`) — a scanner
 * that only understood the prefix would miss the older spelling entirely, which is the kind of
 * blind spot that makes a green audit worthless.
 */
export function importedBuiltins(source) {
  const found = new Set();
  const code = stripComments(source);
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](node:)?([a-z_][a-z0-9_/-]*)['"]/g;
  for (const m of code.matchAll(re)) {
    const spec = m[2];
    // A bare specifier is only a builtin if it names one; otherwise it is a package.
    if (m[1] || Object.prototype.hasOwnProperty.call(CAPABILITY_MODULES, spec)) found.add(spec);
  }
  return found;
}

/**
 * `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource` and `sendBeacon` are GLOBALS: they need
 * no import at all, so an import-only ledger would report a file that calls fetch() as holding
 * no network capability. This pattern set closes that hole — it is the reason the audit cannot
 * be satisfied by simply not importing `node:https`.
 */
const NETWORK_GLOBALS = /\bfetch\s*\(|\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource)\s*\(|\bnavigator\s*\.\s*sendBeacon\s*\(/;

/** The capability classes a file holds, from its imports plus the import-free network globals. */
export function fileCapabilities(source) {
  const caps = new Set();
  for (const spec of importedBuiltins(source)) {
    const cls = CAPABILITY_MODULES[spec];
    if (cls) caps.add(cls);
  }
  if (NETWORK_GLOBALS.test(stripComments(source))) caps.add('network');
  return caps;
}

/**
 * Every external binary a file can execute, as a literal name where the call site names one and
 * as `<dynamic:identifier>` where it does not.
 *
 * Only files that can actually spawn are scanned — a file with no child_process import cannot
 * execute anything, and scanning it would turn prose like "how many agents you are about to
 * spawn (default 2)" into a phantom binary called `default`. That false positive is not
 * hypothetical: it is in src/mcp/server.mjs, and it is why this is gated on the capability.
 */
export function spawnTargets(source) {
  const out = new Set();
  if (!fileCapabilities(source).has('process')) return out;
  const code = stripComments(source);
  const re = /\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)\s*\(\s*(['"`]([^'"`\n]*)['"`]|[A-Za-z_$][\w$]*)/g;
  for (const m of code.matchAll(re)) {
    if (m[2] !== undefined) out.add(m[2]);
    else out.add(`<dynamic:${m[1]}>`);
  }
  return out;
}

/** Every environment variable name the source reads, in both spellings holt uses. */
export function envReads(source) {
  const out = new Set();
  const code = stripComments(source);
  for (const m of code.matchAll(/\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]);
  // holt's licence reader takes `env` as an injected parameter defaulting to process.env, so a
  // detector that only understood `process.env.X` would have missed HOLT_LICENSE entirely —
  // the one variable in the whole product that carries a secret.
  for (const m of code.matchAll(/(?:^|[^.\w$])env\.([A-Z][A-Z0-9_]*)/g)) out.add(m[1]);
  // A computed read cannot be enumerated, so it is reported as an opaque capability rather
  // than silently ignored. Silence about something unknowable is the fail-open shape.
  if (/\bprocess\.env\s*\[/.test(code)) out.add('<computed>');
  return out;
}

/* ══════════════════════════════════════════════════════ INTEGRITY / MANIFEST ══════ */

export const MANIFEST_FILE = 'MANIFEST.sha256';
export const MANIFEST_SIG_FILE = 'MANIFEST.sha256.sig';

/**
 * Ed25519 public keys trusted to sign a release manifest, newest first, SPKI base64 — the same
 * shape and the same rotation rule as src/license.mjs.
 *
 * DELIBERATELY EMPTY, and that is not an oversight. The private half would have to be generated
 * by the owner and held as a repository secret; inventing a plausible-looking key here would
 * produce a build that reports "signature verified" against a key nobody controls, which is
 * worse than no signature at all. Until the owner adds one (SUPPLY-CHAIN.md gives the two
 * commands and names the secret), signature verification reports `unavailable` and
 * `--require-signature` REFUSES rather than passing.
 *
 * This is not the primary authenticity mechanism and was never meant to be: that is the
 * Sigstore provenance attestation produced by the release workflow, which needs no long-lived
 * key at all. This exists for the air-gapped reviewer who cannot reach GitHub to verify one.
 */
export const RELEASE_PUBLIC_KEYS_B64 = [];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The manifest body: `<sha256>  <path>` per file, sorted, newline-terminated.
 *
 * The manifest cannot contain its own hash, so it covers every shipped file EXCEPT itself and
 * its detached signature. Its integrity comes from outside: its digest is a subject of the
 * release provenance attestation.
 */
export function buildManifest(root, files = shippedFiles(root)) {
  const lines = files
    .filter((f) => f !== MANIFEST_FILE && f !== MANIFEST_SIG_FILE)
    .map((f) => `${sha256(fs.readFileSync(path.join(root, f)))}  ${f}`);
  return `${lines.join('\n')}\n`;
}

/** The one number a customer compares against the attested value. */
export function treeDigest(manifestBody) {
  return sha256(Buffer.from(manifestBody, 'utf8'));
}

function parseManifest(body) {
  const map = new Map();
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64})\s\s(.+)$/.exec(line);
    if (!m) return { error: `unparseable manifest line: ${line.slice(0, 80)}` };
    map.set(m[2], m[1]);
  }
  return { map };
}

/**
 * Does the installed tree match the manifest it shipped with?
 *
 * FAIL-CLOSED IN EVERY DIRECTION. A missing manifest, an unparseable manifest, an unreadable
 * file, an extra file, a missing file, one changed byte — each is a FAILURE, never a pass with
 * a note. "Could not check" and "checked and fine" must never share an exit code; treating
 * absent evidence as good news is the defect class this project keeps finding in itself.
 */
export function verifyIntegrity({ root, requireSignature = false, publicKeysB64 = RELEASE_PUBLIC_KEYS_B64 } = {}) {
  const manifestPath = path.join(root, MANIFEST_FILE);
  let body;
  try {
    body = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return {
      ok: false, code: 'no-manifest', signature: 'absent',
      reason: `no ${MANIFEST_FILE} beside this installation — integrity cannot be checked, so it is reported as UNVERIFIED rather than as clean`,
      fix: 'Reinstall from the published tarball (npm install -g holt), which ships one.',
      files: { total: 0, matched: 0, modified: [], missing: [], unexpected: [] },
    };
  }

  const parsed = parseManifest(body);
  if (parsed.error) {
    return { ok: false, code: 'bad-manifest', signature: 'absent', reason: parsed.error, files: { total: 0, matched: 0, modified: [], missing: [], unexpected: [] } };
  }

  // Signature, if the build pins a key and a detached signature is present. Verified over the
  // manifest body EXACTLY as read from disk — never over a re-serialised parse, which is the
  // canonicalisation hole src/license.mjs also refuses to inherit.
  let signature = 'unavailable';
  let sigReason = 'this build pins no release signing key, so publisher authenticity must come from the provenance attestation (see SUPPLY-CHAIN.md)';
  if (publicKeysB64.length) {
    let sig = null;
    try { sig = fs.readFileSync(path.join(root, MANIFEST_SIG_FILE), 'utf8').trim(); } catch { /* absent */ }
    if (!sig) {
      signature = 'absent';
      sigReason = `this build pins a release key but no ${MANIFEST_SIG_FILE} is present`;
    } else {
      signature = 'invalid';
      sigReason = 'the manifest signature does not match any pinned release key — this manifest was edited or is not ours';
      for (const kb64 of publicKeysB64) {
        try {
          const key = createPublicKey({ key: Buffer.from(kb64, 'base64'), format: 'der', type: 'spki' });
          if (edVerify(null, Buffer.from(body, 'utf8'), key, Buffer.from(sig, 'base64'))) {
            signature = 'valid';
            sigReason = 'manifest signed by a pinned holt release key';
            break;
          }
        } catch { /* try the next key */ }
      }
    }
  }
  if (requireSignature && signature !== 'valid') {
    return {
      ok: false, code: 'signature-required', signature, reason: sigReason,
      files: { total: parsed.map.size, matched: 0, modified: [], missing: [], unexpected: [] },
      treeDigest: treeDigest(body),
    };
  }

  const modified = [];
  const missing = [];
  let matched = 0;
  for (const [rel, want] of parsed.map) {
    let got;
    try { got = sha256(fs.readFileSync(path.join(root, rel))); } catch { missing.push(rel); continue; }
    if (got === want) matched++;
    else modified.push({ file: rel, expected: want, actual: got });
  }

  const onDisk = new Set(shippedFiles(root).filter((f) => f !== MANIFEST_FILE && f !== MANIFEST_SIG_FILE));
  const unexpected = [...onDisk].filter((f) => !parsed.map.has(f));

  const ok = modified.length === 0 && missing.length === 0 && unexpected.length === 0;
  return {
    ok,
    code: ok ? 'verified' : 'mismatch',
    signature, signatureReason: sigReason,
    treeDigest: treeDigest(body),
    files: { total: parsed.map.size, matched, modified, missing, unexpected },
    reason: ok
      ? `all ${matched} shipped files match the manifest`
      : `${modified.length} modified, ${missing.length} missing, ${unexpected.length} unexpected`,
  };
}

/* ═══════════════════════════════════════════════════ THE CAPABILITY AUDIT ═════════ */

const declaredModuleCaps = (decl) => new Map(Object.entries(decl));

/**
 * Compare the declaration against the bytes on disk. Returns one entry per check, each with
 * enough detail to act on — a security finding that says only "failed" costs the reviewer the
 * same afternoon it was supposed to save.
 */
export function auditCapabilities({ root, capabilities = CAPABILITIES, moduleLedger = MODULE_LEDGER } = {}) {
  const files = shippedFiles(root).filter(isSource);
  const checks = [];
  const declared = declaredModuleCaps(moduleLedger);

  /* ---- 0. the instrument itself ------------------------------------------------ */
  // Before any conclusion is drawn from what the detectors did NOT find, prove they can still
  // see what IS there. If comment-stripping desynced on any file it will have eaten code, and
  // every clean verdict below it would be an artefact of a broken instrument rather than a
  // property of the package.
  const unsafeStrip = [];
  for (const rel of files) {
    const raw = fs.readFileSync(path.join(root, rel), 'utf8');
    const chk = strippedIsSafe(raw, stripComments(raw));
    if (!chk.safe) unsafeStrip.push({ file: rel, lostImports: chk.lost });
  }
  checks.push({
    id: 'instrument',
    title: 'the detector can still see the code it is judging',
    ok: unsafeStrip.length === 0,
    detail: { filesChecked: files.length, desynced: unsafeStrip },
    summary: unsafeStrip.length
      ? `comment-stripping LOST code in ${unsafeStrip.map((u) => `${u.file} (${u.lostImports.join(', ')})`).join('; ')} — every result below is unreliable and this audit reports FAILURE rather than a clean bill`
      : `all ${files.length} files survive stripping with every import intact, so a clean result below means clean and not blind`,
  });

  /* ---- 1. per-file capability ledger ------------------------------------------- */
  const capViolations = [];
  const staleDeclarations = [];
  const seen = new Set();
  const byClass = Object.fromEntries(CAPABILITY_CLASSES.map((c) => [c, []]));
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    const actual = fileCapabilities(src);
    const want = new Set(declared.get(rel) ?? []);
    seen.add(rel);
    for (const c of actual) {
      byClass[c]?.push(rel);
      if (!want.has(c)) capViolations.push({ file: rel, capability: c, kind: 'undeclared' });
    }
    for (const c of want) if (!actual.has(c)) staleDeclarations.push({ file: rel, capability: c, kind: 'declared-but-absent' });
  }
  for (const rel of declared.keys()) if (!seen.has(rel)) staleDeclarations.push({ file: rel, capability: '*', kind: 'declared-file-not-shipped' });

  checks.push({
    id: 'capabilities',
    title: 'every shipped file holds only the capabilities it declares',
    ok: capViolations.length === 0 && staleDeclarations.length === 0,
    detail: {
      filesScanned: files.length,
      network: byClass.network, process: byClass.process, eval: byClass.eval,
      filesystem: byClass.filesystem.length,
      undeclared: capViolations, stale: staleDeclarations,
    },
    summary: capViolations.length
      ? `${capViolations.length} undeclared capability/ies: ${capViolations.map((v) => `${v.file} -> ${v.capability}`).join(', ')}`
      : staleDeclarations.length
        ? `${staleDeclarations.length} declaration(s) with nothing behind them: ${staleDeclarations.map((v) => `${v.file} -> ${v.capability}`).join(', ')}`
        : `${files.length} files scanned; network capability confined to ${byClass.network.join(', ') || 'no file at all'}`,
  });

  /* ---- 2. network egress ------------------------------------------------------- */
  const declaredEgress = new Set(capabilities.network.egress.map((e) => e.file));
  const actualNetwork = byClass.network;
  const undeclaredEgress = actualNetwork.filter((f) => !declaredEgress.has(f));
  const phantomEgress = [...declaredEgress].filter((f) => !actualNetwork.includes(f));
  checks.push({
    id: 'network',
    title: 'network egress matches the declared destinations',
    ok: undeclaredEgress.length === 0 && phantomEgress.length === 0,
    detail: { declared: capabilities.network.egress, undeclared: undeclaredEgress, phantom: phantomEgress },
    summary: undeclaredEgress.length
      ? `UNDECLARED network capability in ${undeclaredEgress.join(', ')}`
      : phantomEgress.length
        ? `declared egress with no network code behind it: ${phantomEgress.join(', ')}`
        : `${capabilities.network.egress.length} declared egress point(s), all human-triggered and hash-pinned; nothing else in the package can open a socket`
          + ` (plus ${capabilities.network.indirect.length} declared INDIRECT path — a package-manager command holt prints and you confirm)`,
  });

  /* ---- 3. git can never reach the network -------------------------------------- */
  // Behavioural, not textual: the classifier is CALLED. A grep would prove a word is absent
  // from a list; this proves the code refuses.
  const reachable = [];
  for (const verb of capabilities.network.gitVerbsRefused) {
    for (const allowMutation of [false, true]) {
      const v = classify([verb, 'origin', 'main'], { allowMutation });
      if (v.allowed) reachable.push({ verb, allowMutation });
    }
  }
  // Prove the instrument can see a PASS as well as a FAIL: if `rev-parse` were also refused,
  // "nothing reachable" would just mean the classifier says no to everything.
  const controlAllowed = classify(['rev-parse', 'HEAD']).allowed;
  checks.push({
    id: 'git-verbs',
    title: 'no networked git verb is reachable, with or without the mutation opt-in',
    ok: reachable.length === 0 && controlAllowed === true,
    detail: { tested: capabilities.network.gitVerbsRefused.length, reachable, controlVerbAllowed: controlAllowed },
    summary: reachable.length
      ? `REACHABLE: ${reachable.map((r) => `git ${r.verb}${r.allowMutation ? ' (with mutation opt-in)' : ''}`).join(', ')}`
      : controlAllowed
        ? `all ${capabilities.network.gitVerbsRefused.length} networked git verbs refused (control: 'git rev-parse' is still allowed, so this is not a blanket deny)`
        : 'the classifier refused the control verb too — this result proves nothing and is reported as a failure',
  });

  /* ---- 4. external binaries, literal AND dynamic ------------------------------- */
  const declaredBins = new Set(capabilities.binaries.map((b) => b.name));
  const declaredSites = new Map(capabilities.dynamicCallSites.map((s) => [`${s.file}:${s.identifier}`, s]));
  const literalBins = new Set();
  const foundSites = new Set();
  for (const rel of files) {
    for (const t of spawnTargets(fs.readFileSync(path.join(root, rel), 'utf8'))) {
      if (t.startsWith('<dynamic:')) foundSites.add(`${rel}:${t.slice(9, -1)}`);
      else literalBins.add(t);
    }
  }
  const undeclaredBins = [...literalBins].filter((b) => !declaredBins.has(b)).sort();
  const unusedBins = [...declaredBins].filter((b) => !literalBins.has(b)).sort();
  // A variable in the executable position is the one place a subprocess can hide from a
  // string scan, so an unlisted one is a finding, not a shrug.
  const undeclaredSites = [...foundSites].filter((s) => !declaredSites.has(s)).sort();
  const phantomSites = [...declaredSites.keys()].filter((s) => !foundSites.has(s)).sort();
  const okBins = !undeclaredBins.length && !unusedBins.length && !undeclaredSites.length && !phantomSites.length;
  const viaDynamic = capabilities.dynamicCallSites.flatMap((s) => s.canRun).filter((c) => !c.startsWith('<'));
  checks.push({
    id: 'binaries',
    title: 'every external binary the package can execute is declared, including the ones named by a variable',
    ok: okBins,
    detail: {
      declared: capabilities.binaries, dynamicCallSites: capabilities.dynamicCallSites,
      foundLiteral: [...literalBins].sort(), foundDynamic: [...foundSites].sort(),
      undeclared: undeclaredBins, declaredButAbsent: unusedBins,
      undeclaredCallSites: undeclaredSites, declaredCallSitesNotFound: phantomSites,
    },
    summary: undeclaredBins.length ? `UNDECLARED binary/ies: ${undeclaredBins.join(', ')}`
      : undeclaredSites.length ? `UNDECLARED dynamic call site(s): ${undeclaredSites.join(', ')} — a subprocess whose name is a variable is exactly what a string scan misses`
        : unusedBins.length ? `declared but never executed: ${unusedBins.join(', ')}`
          : phantomSites.length ? `declared dynamic call site(s) that no longer exist: ${phantomSites.join(', ')}`
            : `${literalBins.size} binaries named directly (${[...literalBins].sort().join(', ')}) plus ${foundSites.size} call sites that take the binary as a variable, resolving to ${viaDynamic.join(', ')} and to the command you pass \`holt verify --run\``,
  });

  /* ---- 5. environment ---------------------------------------------------------- */
  const declaredEnv = new Set(capabilities.environment.map((e) => e.name));
  const actualEnv = new Set();
  for (const rel of files) for (const n of envReads(fs.readFileSync(path.join(root, rel), 'utf8'))) actualEnv.add(n);
  const undeclaredEnv = [...actualEnv].filter((n) => !declaredEnv.has(n)).sort();
  const unusedEnv = [...declaredEnv].filter((n) => !actualEnv.has(n)).sort();
  checks.push({
    id: 'environment',
    title: 'every environment variable read is declared',
    ok: undeclaredEnv.length === 0 && unusedEnv.length === 0,
    detail: { declared: capabilities.environment, found: [...actualEnv].sort(), undeclared: undeclaredEnv, declaredButUnread: unusedEnv },
    summary: undeclaredEnv.length
      ? `UNDECLARED environment read(s): ${undeclaredEnv.join(', ')}`
      : unusedEnv.length
        ? `declared but never read: ${unusedEnv.join(', ')}`
        : `${actualEnv.size} variables read, all declared, none transmitted (there is nowhere to transmit them to)`,
  });

  return checks;
}

/**
 * The whole audit: identity, integrity, capabilities. One call, one JSON object, no network.
 */
export function audit({ root, requireSignature = false, publicKeysB64 = RELEASE_PUBLIC_KEYS_B64 } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = shippedFiles(root);
  const integrity = verifyIntegrity({ root, requireSignature, publicKeysB64 });
  const checks = [
    {
      id: 'integrity',
      title: 'the installed files match the manifest that shipped with them',
      ok: integrity.ok,
      detail: integrity,
      summary: integrity.ok
        ? `${integrity.files.matched}/${integrity.files.total} files match; manifest signature: ${integrity.signature}`
        : `${integrity.reason}${integrity.fix ? ` — ${integrity.fix}` : ''}`,
    },
    ...auditCapabilities({ root }),
  ];
  const failed = checks.filter((c) => !c.ok);
  return {
    tool: 'holt supply-chain audit',
    package: { name: pkg.name, version: pkg.version, root, files: files.length },
    treeDigest: integrity.treeDigest ?? treeDigest(buildManifest(root, files)),
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    total: checks.length,
    checks,
    statement: {
      reads: CAPABILITIES.filesystem.reads,
      writes: CAPABILITIES.filesystem.writes,
      neverWrites: CAPABILITIES.filesystem.never,
      sends: CAPABILITIES.network.egress.map((e) => ({ destination: e.destination, trigger: e.trigger, sends: e.sends })),
      // Surfaced beside `sends`, not buried, because a subprocess that reaches the network on
      // your behalf is indistinguishable from one that does it in-process as far as a security
      // review is concerned — and no in-process detector can see it.
      indirectNetwork: CAPABILITIES.network.indirect,
      privilege: CAPABILITIES.privilege,
      telemetry: CAPABILITIES.network.telemetry,
    },
  };
}

/* ═══════════════════════════════════════════════ THE PER-FILE MODULE LEDGER ═══════ */

/**
 * Which shipped file holds which capability class. Generated once with
 * `node scripts/gen-manifest.mjs --ledger` and checked against reality on every audit run and
 * in CI, so it cannot drift: adding an `import fs` to a file that had none FAILS until someone
 * writes down that the file now touches the filesystem.
 *
 * A file absent from this table is declared to hold NO capability at all — pure computation.
 * That is the strictest possible default and the reason the table is worth reading: everything
 * dangerous is on it.
 */
export const MODULE_LEDGER = {
  // NETWORK — one file, and it is the installer, not the tool.
  'bin/install-ctags.mjs': ['filesystem', 'network', 'process'],

  // EVAL — one file. `src/deep.mjs` uses createRequire() to load the OPTIONAL jscpd backend,
  // which is a code-loading capability and is declared as one even though the module it loads
  // is a declared optional dependency. A reviewer deciding "can this tool load code I did not
  // audit?" deserves to find that answer on this table rather than in a diff.
  'src/deep.mjs': ['eval', 'filesystem', 'process'],

  // PROCESS — the files that can execute an external binary.
  'bin/holt.mjs': ['filesystem', 'process'],
  'src/git.mjs': ['filesystem', 'process'],
  'src/impact.mjs': ['filesystem', 'process'],
  'src/integrate/adapters.mjs': ['filesystem', 'process'],
  'src/jj.mjs': ['filesystem', 'process'],
  'src/symbols.mjs': ['filesystem', 'process'],
  'src/verify.mjs': ['filesystem', 'process'],

  // FILESYSTEM only.
  'src/actions.mjs': ['filesystem'],
  'src/agent.mjs': ['filesystem'],
  'src/journal.mjs': ['filesystem'],
  'src/license.mjs': ['filesystem'],
  'src/scan.mjs': ['filesystem'],
  'src/supply-chain.mjs': ['filesystem'],
  'src/team/fleet.mjs': ['filesystem'],
  'src/team/policy.mjs': ['filesystem'],
  'src/toolchain.mjs': ['filesystem'],

  // Everything below reaches nothing at all: pure computation and formatting. They are listed
  // with an empty capability set rather than omitted, so that "absent from this table" can mean
  // exactly one thing — a file nobody has classified — and be caught as such.
  'src/analyze.mjs': [],
  'src/ascii-graph.mjs': [],
  'src/branches.mjs': [],
  'src/discover.mjs': [],
  'src/graph-html.mjs': [],
  'src/index.mjs': [],
  'src/integrate/hosts.mjs': [],
  'src/mcp/server.mjs': [],
  'src/order.mjs': [],
  'src/partition.mjs': [],
  'src/render.mjs': [],
  'src/roi.mjs': [],
  'src/tui.mjs': [],
};
