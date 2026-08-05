#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — a release must tell a reader how to install it.
 *
 * THIS EXISTS BECAUSE v0.2.0 SHIPPED WITH A RELEASE BODY THAT DESCRIBED A DIFFERENT PRODUCT.
 * It called holt "an AI-native workspace" and a "control plane", promised a "semantic project
 * graph", and contained no install command at all — while the README, the site and CI all
 * carried the same verified one-liner. Nothing compared them, so the one surface a person
 * reaches from the Releases tab was the only one that was wrong.
 *
 * Prose cannot be gated on being good. It CAN be gated on the two properties that make a
 * release body usable rather than decorative:
 *
 *   1. it contains an install command whose target is concrete, and
 *   2. that target belongs to the release being published — not a previous one, not a
 *      placeholder someone meant to fill in.
 *
 * Both are checked against the release's own tag, so this file never needs editing when the
 * version changes. Missing evidence REFUSES: no body, no tag, no install command — all fail.
 *
 *   node scripts/check-release-body.mjs --tag v0.2.0 --body-file .github/releases/v0.2.0.md
 *   gh release view v0.2.0 --json body -q .body | node scripts/check-release-body.mjs --tag v0.2.0 --stdin
 *   node scripts/check-release-body.mjs --all      # every checked-in body, tag from its filename
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BODIES_DIR = path.join(ROOT, '.github', 'releases');
export const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');

/** owner/name, from package.json, so a fork does not have to edit this script. */
export async function repoSlug(root = ROOT) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const url = String(pkg.repository?.url ?? '');
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  if (!m) throw new Error('package.json has no github repository url to derive the release host from');
  return `${m[1]}/${m[2]}`;
}

/** `npm install -g X`, `npm i --global X`, `npx X` — the shapes a reader can actually paste. */
const INSTALL = /\b(?:npm\s+(?:install|i)\s+(?:-g|--global)|npx(?:\s+--yes)?)\s+(\S+)/gi;

/**
 * A target nobody can paste. Angle brackets, ALL-CAPS stand-ins and bare ellipses are how an
 * unfinished template reads, and an unfinished template is exactly what this gate is for.
 */
function isPlaceholder(target) {
  return /^[`'"]*(?:<|\.\.\.|\$\{|TARBALL|URL|PACKAGE|VERSION|TAG)/i.test(target)
    || /[<>]/.test(target)
    || target.replace(/[`'"]/g, '').length === 0;
}

const clean = (t) => t.replace(/^[`'"(]+|[`'".,)]+$/g, '');

// Performance/rate claims in release prose must point at the exact retained evidence, not merely
// at a methods page. Version numbers and install URLs do not match because a unit/rate is required.
const MEASURED_CLAIM = /\b\d+(?:\.\d+)?(?:\s*(?:ms|milliseconds?|seconds?|kb|mb|gb|%)|\s+s\b|\s*\/\s*\d+)\b/gi;
const EVIDENCE_LINK = /\[[^\]]+\]\((?:https:\/\/github\.com\/[^)]+\/(?:blob|tree)\/[^)]+\/(?:docs\/evidence|eval\/results)[^)]+|(?:\.\.\/)*?(?:docs\/evidence|eval\/results)[^)]+)\)/i;
const LIVE_HOST_CLAIM = /(?:host coverage[^.\n]*verified end[- ]to[- ]end|real[- ]host[^.\n]*(?:verified|proven|passed)|hosts? ci (?:actually )?drives)/i;

/** Evidence-bearing claims shared by release bodies and the current changelog entry. */
export function checkEvidenceClaims(text) {
  const problems = [];
  const source = String(text ?? '');
  // Commands, literal program output and URLs can contain ratios/status-like tokens (for example
  // `scanned 0/0` or an HTTP 404) without making a result claim. Gate prose claims, not quoted
  // evidence of the bug being fixed.
  const claimProse = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const measured = [...claimProse.matchAll(MEASURED_CLAIM)].map((m) => m[0]);
  if (measured.length > 0 && !EVIDENCE_LINK.test(source)) {
    problems.push(
      `measured value(s) lack a link to an exact retained evidence artifact: ${[...new Set(measured)].join(', ')}. `
      + 'A methods page such as BENCHMARKS.md is not the result artifact.');
  }
  if (LIVE_HOST_CLAIM.test(claimProse) && !EVIDENCE_LINK.test(source)) {
    problems.push(
      'the body claims real/end-to-end host proof without an exact retained host-run artifact. '
      + 'Config and payload contract tests are not live-host enforcement evidence.');
  }
  return problems;
}

/** Only the candidate version's changelog entry is a current release claim. */
export function changelogSection(text, version) {
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text ?? '').match(
    new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\n##\\s|$)`),
  );
  return match?.[1] ?? '';
}

/**
 * @param {string} body   the release body markdown
 * @param {string} tag    the tag being released, e.g. "v0.2.0"
 * @param {string} slug   owner/name
 * @returns {string[]}    reasons it must not ship; empty means it may
 */
export function checkReleaseBody(body, tag, slug) {
  const problems = [];
  const text = String(body ?? '');

  if (!text.trim()) return ['the release body is empty — a release with no body cannot tell anyone how to install it'];
  if (!tag) return ['no tag given — the body cannot be checked against the release it belongs to'];

  const targets = [...text.matchAll(INSTALL)].map((m) => clean(m[1]));
  if (targets.length === 0) {
    problems.push(
      'the release body contains no install command. A reader arriving from the Releases tab has ' +
      'no way to run this. Add the same command the README uses, in a fenced code block.');
  }

  const usable = targets.filter((t) => !isPlaceholder(t));
  if (targets.length > 0 && usable.length === 0) {
    problems.push(
      `every install command is a placeholder (${targets.join(', ')}) — the template was published unfilled`);
  }

  // An install command that points at a DIFFERENT release is worse than none: it looks correct
  // and silently gives the reader the wrong version.
  const urls = usable.filter((t) => /^https?:/i.test(t));
  const host = `https://github.com/${slug}/releases/download/${tag}/`;
  const foreign = urls.filter((u) => !u.toLowerCase().startsWith(host.toLowerCase()));
  if (urls.length > 0 && foreign.length > 0) {
    problems.push(
      `install command(s) point outside this release's own assets: ${foreign.join(', ')} ` +
      `(expected a URL under ${host})`);
  }

  // A body that never names its own version is filler: it would read identically for any release.
  const version = tag.replace(/^v/, '');
  if (!text.includes(tag) && !text.includes(version)) {
    problems.push(`the body never mentions ${tag} — it would read identically for any release`);
  }

  problems.push(...checkEvidenceClaims(text));

  return problems;
}

/* ------------------------------------------------------------------------- cli ---- */

function parseArgs(argv) {
  const opts = { all: false, stdin: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') opts.all = true;
    else if (argv[i] === '--stdin') opts.stdin = true;
    else if (argv[i] === '--tag') opts.tag = argv[++i];
    else if (argv[i] === '--body-file') opts.bodyFile = argv[++i];
    else if (argv[i] === '--repo') opts.repo = argv[++i];
    // A GATE THAT IGNORES A MISSPELLED FLAG IS NOT A GATE. `--file` instead of `--body-file` fell
    // through here silently, leaving bodyFile undefined, and the run died deep inside readFile
    // with "path must be of type string" — a message that names neither the flag nor the fix.
    else throw new Error(`unknown option ${JSON.stringify(argv[i])} (expected --all, --stdin, --tag, --body-file, --repo)`);
  }
  return opts;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const slug = opts.repo ?? await repoSlug();
  const jobs = [];

  if (opts.all) {
    const files = await fs.readdir(BODIES_DIR).catch(() => null);
    // An empty or missing directory is not a pass. Silence here would mean the gate stopped
    // looking at anything the day someone moved the folder.
    if (!files) { console.error(`check-release-body: ${BODIES_DIR} does not exist`); process.exit(1); }
    const bodies = files.filter((f) => f.endsWith('.md'));
    if (bodies.length === 0) { console.error(`check-release-body: no release bodies in ${BODIES_DIR}`); process.exit(1); }
    for (const f of bodies) {
      jobs.push({ label: f, tag: path.basename(f, '.md'), body: await fs.readFile(path.join(BODIES_DIR, f), 'utf8') });
    }

    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const changelog = await fs.readFile(CHANGELOG_PATH, 'utf8');
    const current = changelogSection(changelog, pkg.version);
    if (!current.trim()) {
      console.error(`::error::CHANGELOG.md: no current ## ${pkg.version} entry to evidence-check`);
      process.exit(1);
    }
    const changelogProblems = checkEvidenceClaims(current);
    if (changelogProblems.length) {
      for (const p of changelogProblems) console.error(`::error::CHANGELOG.md (${pkg.version}): ${p}`);
      process.exit(1);
    }
    console.log(`ok  CHANGELOG.md current entry (${pkg.version})`);
  } else {
    const body = opts.stdin ? await readStdin() : await fs.readFile(opts.bodyFile, 'utf8');
    jobs.push({ label: opts.bodyFile ?? 'stdin', tag: opts.tag, body });
  }

  let failed = 0;
  for (const job of jobs) {
    const problems = checkReleaseBody(job.body, job.tag, slug);
    if (problems.length === 0) {
      console.log(`ok  ${job.label} (${job.tag})`);
    } else {
      failed++;
      for (const p of problems) console.error(`::error::${job.label}: ${p}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

// pathToFileURL, not `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`, and for
// exactly the reason written down in scripts/generate-hosts.mjs: those two strings are produced by
// different machinery, so on Windows a drive-letter case difference or an 8.3 short name makes the
// comparison false and `main()` never runs. The failure mode is the worst one a GATE can have —
// the step exits 0 having checked nothing at all. Every other entry point in scripts/ already uses
// this idiom; this one was the straggler, found by `npm run lint:paths`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`check-release-body: ${err.message}`); process.exit(1); });
}
