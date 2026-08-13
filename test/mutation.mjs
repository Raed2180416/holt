#!/usr/bin/env node
/**
 * holt — targeted mutation testing.
 *
 * A green test suite proves the tests RAN. It does not prove they would have FAILED on a real
 * defect. This harness answers that directly: it deliberately breaks a specific, high-stakes
 * behaviour in the source, runs the tests that are supposed to cover it, and asserts they GO RED.
 *
 * A mutation that survives is a hole: the code could ship broken in exactly that way and every
 * test would still pass.
 *
 * Why hand-picked mutations rather than only Stryker: Stryker mutates everything, which is the
 * right tool for a coverage percentage but spends most of its time on mutants nobody cares about
 * (a flipped `<` in a sort comparator). The mutations below are the ones where being wrong is
 * DANGEROUS — a tool that authorises deleting work, or runs a command it promised never to run.
 * Both are worth having; this one runs in seconds and lives in CI.
 *
 *   node test/mutation.mjs           # run all
 *   node test/mutation.mjs --list    # show them
 *   node test/mutation.mjs --only id1,id2  # run an exact focused subset
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ISOLATION IS LOAD-BEARING. Every mutation is applied to a disposable COPY of this repo and
 * the tests run there — never in the live tree. Proven necessary the hard way: the
 * `allowlist-open` mutation disables holt's refusal layer, and the safety suite asserts
 * refusal by CALLING git() — so under that mutation, the command expected to be refused
 * actually executed. With tests running in the live repo, `git reset --hard` really ran here,
 * and erased uncommitted work three separate times before it was diagnosed (2026-07-31). The
 * pre-commit verification run was the destroyer. Defense in depth now: (1) tests point live
 * ammunition only at throwaway fixtures, (2) src/git.mjs refuses destroyers at a structurally
 * independent first gate, (3) this harness never lets a mutated holt near the real tree —
 * and the tripwire below proves (3) on every single run.
 */
const COPY_SKIP = new Set(['.git', 'node_modules']);

export async function makeWorkCopy() {
  const base = process.env.HOLT_TMPDIR ?? os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const work = await fs.mkdtemp(path.join(base, 'holt-mutation-'));
  await fs.cp(ROOT, work, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === '') return true;
      return !COPY_SKIP.has(rel.split(path.sep)[0]);
    },
  });
  try {
    await fs.symlink(path.join(ROOT, 'node_modules'), path.join(work, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    await fs.cp(path.join(ROOT, 'node_modules'), path.join(work, 'node_modules'), { recursive: true });
  }
  return work;
}

/** Byte-level state of the REAL repo: HEAD + full porcelain status. Any drift = isolation broken. */
async function repoFingerprint() {
  const head = await run('git', ['rev-parse', 'HEAD'], ROOT);
  if (head.code !== 0) return null; // not a git checkout (e.g. unpacked tarball) — tripwire unavailable
  const st = await run('git', ['status', '--porcelain=v2', '--untracked-files=all'], ROOT);
  return `${head.stdout}\n${st.stdout}`;
}

/**
 * Each mutation states the DEFECT it simulates, so a survivor reads as a missing test rather
 * than a puzzle.
 */
export const MUTATIONS = [
  {
    "id": "collisions-head-only",
    "defect": "collisions fall back to committed heads, so a conflict in UNCOMMITTED work — the flagship case — is reported as no collision",
    "file": "src/analyze.mjs",
    "find": "    if (!dirty || scanResult.strictReadOnly) return w.head ?? null;",
    "replace": "    return w.head ?? null; // mutated: uncommitted sides invisible again",
    "tests": [
      "test/e2e/detection.test.mjs"
    ]
  },
  {
    "id": "primary-is-disposable",
    "defect": "the main-working-tree gate is removed — a clean solo repository's ONLY worktree is reported disposable, gate exits 0, and the chain `holt gate $id && rm -rf $id` deletes the repository including .git",
    "file": "src/analyze.mjs",
    "find": "    if (w.isPrimary) {",
    "replace": "    if (false) { // mutated: main working tree offered as a deletion candidate",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "for-loop-body-unseen",
    "defect": "a for-loop over a glob is not decomposed, so `for d in ../wt-*; do rm -rf $d; done` — the mergify incident verbatim — runs its destroyer body unseen and is ALLOWED",
    "file": "src/agent.mjs",
    "find": "  for (const body of expandForLoops(command)) {",
    "replace": "  for (const body of []) { void expandForLoops; // mutated: loop bodies unseen",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "worktree-glob-target-dropped",
    "defect": "the worktree layer resolves only ONE exact path, so `git worktree remove -f ../wt-*` (the literal mergify verb) matches no workstream and is allowed",
    "file": "src/agent.mjs",
    "find": "      : await targetWorkstreams(report, hit.pattern ?? hit.target, cwd);",
    "replace": "      : [await findWorkstream(report, hit.target, cwd)].filter(Boolean); // mutated: glob target dropped",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "containment-ancestor-dropped",
    "defect": "a target that CONTAINS the worktrees (rm -rf .., rm -rf ../wt-*) is dropped as not-holt's-to-defend instead of destroying them — the mergify 29-worktree incident, in the spelling it took",
    "file": "src/agent.mjs",
    "find": "      for (const reached of rootsReachedFromAbove(roots, abs, suffix, globWorkBudget)) {",
    "replace": "      for (const reached of []) { void rootsReachedFromAbove; // mutated: ancestor targets dropped",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "primary-removability-read-as-content",
    "defect": "the content verbs read the primary's `safe` flag (which means \"not removable\") instead of contentReproducible, so in a single-clone repo — the layout almost every repository has — `git reset --hard`, `git clean -fdx` and `git checkout -- .` are DENIED FOREVER, even on a byte-clean tree, with no escape hatch",
    "file": "src/agent.mjs",
    "find": "    : targets.filter((s) => (s.isPrimary ? s.contentReproducible === false : !s.safe));",
    "replace": "    : targets.filter((s) => !s.safe); // mutated: removability read as content",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "windows-path-not-unescaped",
    "defect": "inline strings are taken as raw source, so a Windows path spelled correctly in JS (`'C:\\\\p\\\\wt'`) resolves to nothing and holt ALLOWS the removal — a silent under-refusal on Windows only",
    "file": "src/agent.mjs",
    "find": "    .map((m) => m[1].replace(/\\\\\\\\/g, '\\\\'))",
    "replace": "    .map((m) => m[1]) // mutated: source spelling used as the path",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "proxy-targets-every-string",
    "defect": "the `rm -rf <str>` targeting proxy is applied to every quoted string again, so a path named only as a shelled-out command's cwd is read as a deletion target — `node -e \"execSync('git log',{cwd:'<repo>'})\"` is denied as rm -rf of the repository",
    "file": "src/agent.mjs",
    "find": "          : (namesADestroyer ? await viaWorktree(`rm -rf ${str}`) : null);",
    "replace": "          : await viaWorktree(`rm -rf ${str}`); // mutated: proxy applied to every string",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "inline-shellout-misses-argv-forms",
    "defect": "execFile/spawn/spawnSync drop out of the inline shell-out detector, so `node -e \"execFile('rm',['-rf','<repo>'])\"` matches no rule at all and is silently allowed",
    "file": "src/agent.mjs",
    "find": "\\b(?:execSync|execFile|execFileSync|spawn|spawnSync|system|popen|qx)\\s*\\(|%x[({[]/",
    "replace": "\\bexecSync\\s*\\(/",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "ownership-inferred-not-recorded",
    "defect": "uninstall goes back to inferring ownership from the residue instead of the install receipt — it either leaves .cursor/.claude/.junie behind (so a fully-uninstalled repo self-detects 13 agent hosts) or deletes a user's own file that merely looks like holt's default",
    "file": "src/integrate/adapters.mjs",
    "find": "        const ours = receiptOwnsFileObservation(receipt, 'AGENTS.md', transaction);",
    "replace": "      const ours = false; // mutated: ownership inferred from residue again",
    "tests": [
      "test/e2e/integrate-upgrade.test.mjs"
    ]
  },
  {
    id: 'agents-empty-residue-authorizes-delete',
    defect: 'uninstall treats an empty post-strip AGENTS.md as proof holt created the file, so an unreceipted user file containing only a copied holt block is deleted',
    file: 'src/integrate/adapters.mjs',
    find: '        if (ours) {',
    replace: '        if (ours || !stripped) { // mutated: empty residue substitutes for ownership',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'opencode-same-name-overwritten',
    defect: 'the installer treats the filename .opencode/plugins/holt.js as ownership and overwrites a repository\'s pre-existing plugin',
    file: 'src/integrate/adapters.mjs',
    find: '  // install receipt still proves holt created, or an exact current no-op; otherwise leave it.\n  const check = await mayReplaceGeneratedFile(repoRoot, file, wanted);\n  if (!check.ok) {',
    replace: '  // mutated: filename is ownership\n  const check = { ok: true, created: true, unchanged: false, ownedBefore: false };\n  if (!check.ok) {',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'opencode-marker-authorizes-delete',
    defect: 'uninstall deletes a same-name OpenCode plugin from a marker substring instead of requiring an unmodified receipt-owned file',
    file: 'src/integrate/adapters.mjs',
    find: "      if (receiptOwnsFileObservation(receipt, rel, transaction)) {\n        const mutation = await transaction.commit(null, { onBeforeMutation: onBeforeFileMutation });\n        results.push({\n          adapter: 'opencode'",
    replace: "      if (true) { // mutated: filename/marker authorizes whole-file deletion\n        const mutation = await transaction.commit(null, { onBeforeMutation: onBeforeFileMutation });\n        results.push({\n          adapter: 'opencode'",
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'hook-marker-authorizes-whole-file-delete',
    defect: 'a generated-marker substring again authorizes replacing and deleting an edited pre-commit hook, destroying the user policy added beside that marker',
    file: 'src/integrate/adapters.mjs',
    find: "      } else if (transaction.state === 'leave' || transaction.state === 'current') {\n        results.push({",
    replace: "      } else if (transaction.state === 'leave' || transaction.state === 'current') {\n        if ((await fs.readFile(file, 'utf8')).includes(PRE_COMMIT_MARKER)) await fs.rm(file, { force: true }); // mutated: marker means deletion authority\n        results.push({",
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'shared-hook-exact-bytes-authorize-delete',
    defect: 'an exact generated pre-commit body is treated as ownership even when this installation has no receipt for the shared hook',
    file: 'src/integrate/receipt.mjs',
    find: "  const recorded = r.shared?.[key];\n  if (!recorded) return { state: 'unowned', sha256, stat: observed.stat };\n  const accepted = Array.isArray(recorded) ? recorded : [recorded];",
    replace: '  const recorded = r.shared?.[key];\n  const accepted = recorded ? (Array.isArray(recorded) ? recorded : [recorded]) : [identityToken(sha256, observed.stat)]; // mutated: current bytes substitute for receipt ownership',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'shared-hook-race-not-reverified-after-quarantine',
    defect: 'a shared hook replaced after ownership was checked is moved and deleted or overwritten without verifying that the authorised inode actually moved',
    file: 'src/integrate/receipt.mjs',
    find: '    if (!moved.ok || !sameInode(observed.stat, moved.stat) || hashBytes(moved.bytes) !== sha256) {',
    replace: '    if (!moved.ok) { // mutated: pathname ownership is not rebound after the rename',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'shared-hook-byte-identical-inode-swap-accepted',
    defect: 'post-quarantine verification compares bytes but lets a replacement inode inherit the earlier hook authorization',
    file: 'src/integrate/receipt.mjs',
    find: '    if (!moved.ok || !sameInode(observed.stat, moved.stat) || hashBytes(moved.bytes) !== sha256) {',
    replace: '    if (!moved.ok || hashBytes(moved.bytes) !== sha256) { // mutated: byte equality transfers inode authorization',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'project-file-race-not-reverified-after-retirement',
    defect: 'a project config replaced after parsing is moved and then mutated without proving the retired inode and bytes are the observation that authorised the action',
    file: 'src/integrate/receipt.mjs',
    find: '      if (!moved.ok || !sameRetiredObservation(stable.stat, moved.stat)\n        || hashBytes(moved.bytes) !== observation.sha256) {',
    replace: '      if (!moved.ok) { // mutated: the pathname occupant after inspection inherits the old decision',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'project-file-same-inode-rewrite-accepted',
    defect: 'a same-inode idempotent rewrite after the uninstall snapshot is accepted solely because its bytes and inode match, erasing a newer lifecycle publication',
    file: 'src/integrate/receipt.mjs',
    find: 'const sameRetiredObservation = (left, right) => sameInode(left, right)\n  && Number(left.size) === Number(right.size)\n  && Number(left.mtimeMs) === Number(right.mtimeMs)\n  && Number(left.mode) === Number(right.mode)\n  && String(left.uid) === String(right.uid)\n  && String(left.gid) === String(right.gid)\n  && Number(left.nlink) === Number(right.nlink);',
    replace: 'const sameRetiredObservation = (left, right) => sameInode(left, right); // mutated: same-inode rewrites inherit the old lifecycle',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'project-receipt-bytes-transfer-inode-authority',
    defect: 'a current project-file receipt compares only bytes, so a later byte-identical inode inherits whole-file uninstall authority',
    file: 'src/integrate/receipt.mjs',
    find: "const projectTokenMatches = (token, observation) => projectTokenShape(token)\n  && observation?.state === 'present'\n  && token.worktree === observation.worktree\n  && tokenMatches(token, observation.sha256, observation.stat);",
    replace: "const projectTokenMatches = (token, observation) => projectTokenShape(token)\n  && observation?.state === 'present'\n  && token.sha256 === observation.sha256; // mutated: bytes transfer authority across inode/worktree",
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'project-legacy-hash-authorizes-delete',
    defect: 'a legacy content-only project receipt is treated as deletion authority even though it cannot distinguish the authored file from a later same-byte replacement',
    file: 'src/integrate/receipt.mjs',
    find: '  return (Array.isArray(recorded) ? recorded : [recorded])\n    .some((entry) => projectTokenMatches(entry, observation));',
    replace: "  return (Array.isArray(recorded) ? recorded : [recorded])\n    .some((entry) => typeof entry === 'string' ? entry === observation.sha256 : projectTokenMatches(entry, observation)); // mutated: legacy bytes authorize deletion",
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'project-receipt-skips-post-publish-token-check',
    defect: 'receipt publication reports success after the authored project file was replaced between commit and recording',
    file: 'src/integrate/receipt.mjs',
    find: '    // The file token was the only authority supplied by the caller. Re-check after durable receipt\n    // publication so a substitution during the publish window cannot be reported as installed.\n    if (verify && !(await verify())) return false;',
    replace: '    // mutated: a replacement after file commit is never reverified\n    if (false && verify && !(await verify())) return false;',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'project-receipt-concurrent-writer-reported-success',
    defect: 'a receipt compare-and-swap loss is reported as success instead of reopening and merging the concurrent winner',
    file: 'src/integrate/receipt.mjs',
    find: "      if (error?.code === 'EINTEGRATIONRACE') continue;",
    replace: "      if (error?.code === 'EINTEGRATIONRACE') return true; // mutated: lost update reported successful",
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'project-receipt-erases-sibling-worktree-token',
    defect: 'recording one worktree replaces every identity for the path, so sibling worktrees lose uninstall ownership',
    file: 'src/integrate/receipt.mjs',
    find: "          || !entry || typeof entry !== 'object' || entry.worktree !== token.worktree),",
    replace: "          || false), // mutated: recording this worktree erases current sibling identities",
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'cli-uninstall-reopens-receipt-at-end',
    defect: 'multi-worktree CLI uninstall reopens the receipt only after all adapters finish, so a concurrent re-integrate can publish the same semantic receipt and have the older lifecycle clear it',
    file: 'bin/holt.mjs',
    find: '        transaction: initialReceipt.transaction,',
    replace: '        transaction: null, // mutated: final clearing reopens the path instead of using the initial snapshot',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'shared-hook-receipt-drops-inode-identity',
    defect: 'a v2 shared-hook receipt compares only bytes, so a later byte-identical inode inherits deletion authority from the file Holt actually created',
    file: 'src/integrate/receipt.mjs',
    find: "const receiptEntryMatches = (entry, sha256, stat) => !!entry\n  && typeof entry === 'object'\n  && tokenMatches(entry, sha256, stat);",
    replace: "const receiptEntryMatches = (entry, sha256, stat) => { void stat; return typeof entry === 'string'\n  ? entry === sha256\n  : entry?.sha256 === sha256; }; // mutated: bytes transfer ownership across inodes",
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'shared-hook-receipt-adopts-post-create-replacement',
    defect: 'receipt publication ignores the descriptor identity returned by exclusive creation and records whichever file currently occupies the hook pathname',
    file: 'src/integrate/receipt.mjs',
    find: '    return observed.ok && tokenMatches(exactRecord, hashBytes(observed.bytes), observed.stat);',
    replace: '    return observed.ok; // mutated: a post-create replacement is adopted into the receipt',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'shared-hook-retirement-deletes-recovery-copy',
    defect: 'successful uninstall unlinks the quarantined inode, recreating the last-copy loss that recoverable retirement is meant to eliminate',
    file: 'src/integrate/receipt.mjs',
    find: '  return staged.stagedPath;\n}\n\n/**\n * Restore a copy without replacing',
    replace: '  await fs.unlink(staged.stagedPath); // mutated: successful retirement destroys the recovery copy\n  await fs.rmdir(staged.stagingDir).catch(() => {});\n  return staged.stagedPath;\n}\n\n/**\n * Restore a copy without replacing',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'shared-hook-restore-deletes-last-copy',
    defect: 'restore publishes a new pathname and then deletes the quarantine copy, so a concurrent loss of the publication erases every remaining copy',
    file: 'src/integrate/receipt.mjs',
    find: '    return { recoveryPath: staged.stagedPath, creation };\n  } catch (cause) {',
    replace: '    await fs.unlink(staged.stagedPath); // mutated: restoration destroys its only durable recovery copy\n    await fs.rmdir(staged.stagingDir).catch(() => {});\n    return { recoveryPath: staged.stagedPath, creation };\n  } catch (cause) {',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'shared-hook-failed-install-left-active',
    defect: 'an authored hook remains executable after receipt publication fails, so retry sees residue that uninstall can never prove Holt owns',
    file: 'src/integrate/adapters.mjs',
    find: '    if (creation) {\n      try {\n        const rejected = await quarantineReceiptOwnedSharedFile(',
    replace: '    if (false) { // mutated: failed authored hook is left active and unowned\n      try {\n        const rejected = await quarantineReceiptOwnedSharedFile(',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'shared-hook-rollback-not-receipted',
    defect: 'a failed upgrade copies the prior hook back but does not bind the new inode into the receipt, so the next retry cannot reconcile it',
    file: 'src/integrate/adapters.mjs',
    find: "        if (!(await recordSharedCreated(\n          repoRoot, 'git-hooks/pre-commit', file, recovery.creation,\n        ))) {",
    replace: "        if (false) { // mutated: restored inode is never rebound into receipt ownership",
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'shared-hook-install-restores-raw-path-read',
    defect: 'Git-hook install reads the pathname before the nonblocking descriptor transaction, reopening both FIFO hangs and an unbound identity window',
    file: 'src/integrate/adapters.mjs',
    find: '  const transaction = await quarantineReceiptOwnedSharedFile(\n    repoRoot,\n    \'git-hooks/pre-commit\',',
    replace: '  await fs.readFile(file, \'utf8\'); // mutated: unsafe preliminary pathname observation\n  const transaction = await quarantineReceiptOwnedSharedFile(\n    repoRoot,\n    \'git-hooks/pre-commit\',',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'shared-hook-uninstall-restores-raw-path-read',
    defect: 'Git-hook uninstall reads the pathname before the nonblocking descriptor transaction, so a FIFO can block removal forever',
    file: 'src/integrate/adapters.mjs',
    find: '    try {\n      const transaction = await quarantineReceiptOwnedSharedFile(\n        repoRoot,\n        \'git-hooks/pre-commit\',',
    replace: '    try {\n      await fs.readFile(file, \'utf8\'); // mutated: unsafe preliminary pathname observation\n      const transaction = await quarantineReceiptOwnedSharedFile(\n        repoRoot,\n        \'git-hooks/pre-commit\',',
    tests: ['test/e2e/integrate-upgrade.test.mjs'],
  },
  {
    id: 'restored-same-mode-inode-swap-accepted',
    defect: 'restoration verifies bytes and executable mode from a new descriptor but forgets to bind that descriptor to the inode observed at the path boundary',
    file: 'src/actions.mjs',
    find: '  if (!stable.ok || String(stable.stat.dev) !== String(st.dev)\n    || String(stable.stat.ino) !== String(st.ino)\n    || !stable.bytes.equals(entry.content)) {',
    replace: '  if (!stable.ok || !stable.bytes.equals(entry.content)) { // mutated: a same-mode replacement inode is accepted',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    "id": "hook-retirement-blind",
    "defect": "uninstall walks holt's table of known events again — a hook holt wired on an event it has since retired is never looked at, so `holt uninstall` leaves it pointing at a binary the user is about to delete",
    "file": "src/integrate/adapters.mjs",
    "find": "      for (const event of Object.keys(cfg.hooks ?? {})) {\n        if (!Array.isArray(cfg.hooks?.[event])) continue;\n        const isMine = (entry) => {",
    "replace": "      for (const event of Object.keys(CLAUDE_EVENT_SUBCOMMAND)) { // mutated: retirement blind spot\n        if (!Array.isArray(cfg.hooks?.[event])) continue;\n        const isMine = (entry) => {",
    "tests": [
      "test/e2e/integrate-upgrade.test.mjs"
    ]
  },
  {
    "id": "user-regex-runs-unbounded",
    "defect": "familyOverrides are matched on the main thread again — a `.holtrc.json` regex with catastrophic backtracking hangs every holt command including the blocking guard, and nothing in JS can interrupt it",
    "file": "src/discover.mjs",
    "find": "  const safeOverrides = await screenOverrides(familyOverrides, workstreams.map((w) => w.id), {",
    "replace": "  const safeOverrides = familyOverrides; const _unused = ((x) => x)({ // mutated: user regex run unscreened",
    "tests": [
      "test/unit/saferegex.test.mjs"
    ]
  },
  {
    "id": "stash-cap-reads-as-all-clear",
    "defect": "past MAX_ENTRIES the guard reports 'nothing at risk among the 25 I scanned' as a clean allow — `git stash clear` and a drop of stash@{30} destroy a sole copy holt never examined",
    "file": "src/agent.mjs",
    "find": "    if (reachesUnscanned) {",
    "replace": "    if (false) { // mutated: the unscanned tail is treated as an all-clear",
    "tests": [
      "test/e2e/stash-evidence.test.mjs"
    ]
  },
  {
    "id": "mutation-verbs-uncovered",
    "defect": "the reset --hard rule is removed — holt blocks worktree DELETION but allows the command that destroys the same work in place",
    "file": "src/agent.mjs",
    "find": "  { re: new RegExp(`\\\\bgit\\\\s+${GIT_GLOBALS}reset\\\\s+(?:${TARGET}\\\\s+)*--hard\\\\b`), kind: 'git reset --hard (discards uncommitted work)', cwdTarget: true },",
    "replace": "  // mutated: mutation verb uncovered",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "file-granularity-unwatched",
    "defect": "the file layer is switched off — holt blocks worktree destruction but allows `rm <file>`, `git rm -f`, `truncate`, `shred`, `mv` and `> <file>` against the only copy of a file",
    "file": "src/agent.mjs",
    "find": "  const fileVerdict = fileTargets.length ? await assessFileTargets(fileTargets, cwd, ctx) : null;",
    "replace": "  const fileVerdict = null; void fileTargets; // mutated: file granularity unwatched",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "generated-confirmation-becomes-deny",
    "defect": "generated-looking bytes lose the confirmation path and become a hard refusal, so normal cleanup is blocked even when the user can verify regeneration",
    "file": "src/agent.mjs",
    "find": "  if (likelyGenerated.length > 0 && likelyGenerated.every(Boolean)) {",
    "replace": "  if (false) { // mutated: generated-looking hits fall through to a hard deny",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    "id": "primary-tree-unwatched",
    "defect": "the hook stops scanning the primary worktree — the one tree git REFUSES to lock, so the hook is its only protection",
    "file": "src/agent.mjs",
    "find": "    ({ report } = await cachedReport(cwd, { includePrimary: true }));\n  } catch (err) {",
    "replace": "    ({ report } = await cachedReport(cwd));\n  } catch (err) {",
    "tests": [
      "test/e2e/integration.test.mjs"
    ]
  },
  {
    id: 'safe-always',
    defect: 'safeToDelete() calls every workstream disposable — the catastrophic failure',
    file: 'src/analyze.mjs',
    find: '      safe: reasons.length === 0,',
    replace: '      safe: true,',
    tests: ['test/e2e/break-it.test.mjs', 'test/e2e/detection.test.mjs'],
  },
  {
    id: 'unique-loose',
    defect: 'uniqueWork() treats a symbol shared by several workstreams as unique to each',
    file: 'src/analyze.mjs',
    find: '        if (symbolOwners.get(k).length === 1) return true;',
    replace: '        if (symbolOwners.get(k).length >= 1) return true; // mutated: every symbol is "unique"',
    tests: ['test/e2e/detection.test.mjs', 'test/e2e/destructive-authority.test.mjs'],
  },
  {
    id: 'ignore-uncommitted',
    defect: 'safeToDelete() ignores the uncommitted layer — the layer git cannot see',
    file: 'src/analyze.mjs',
    find: "    if (uncommittedCount > 0) reasons.push(`${uncommittedCount} uncommitted file(s)`);",
    replace: '    // mutated: uncommitted layer ignored',
    tests: ['test/e2e/break-it.test.mjs'],
  },
  {
    // THE DEFECT THIS ANCHOR WAS WRITTEN FOR: `gate` counted the gitignored layer and `rescue`
    // did not, so one product gave two opposite answers to "would deleting this lose work?" —
    // and the one that exited 0 was the one a `rescue && worktree remove` chain trusts. Dropping
    // the layer HERE now breaks BOTH commands at once, which is exactly the property the fix
    // bought: they can no longer be wrong independently.
    id: 'atrisk-drops-ignored',
    defect: 'contentAtRisk() forgets the gitignored layer — gate and rescue silently disagree again',
    file: 'src/analyze.mjs',
    find: '  const ignored = (w?.ignored?.files ?? []).filter(Boolean);',
    replace: '  const ignored = [];',
    tests: ['test/e2e/actions.test.mjs', 'test/e2e/break-it.test.mjs'],
  },
  {
    id: 'atrisk-blind-reads-empty',
    defect: 'a probe that FAILED reports as an empty worktree — absence of evidence becomes a green light',
    file: 'src/analyze.mjs',
    find: "  if (w?.ignored?.how === 'ignored-probe-failed') {",
    replace: '  if (false) {',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'rescue-builds-own-fileset',
    defect: 'rescue re-derives its own content set instead of sharing the gate — the drift that caused the defect',
    file: 'src/actions.mjs',
    find: '  const files = [...new Set([...risk.files, ...risk.unmeasured])].sort();',
    replace: '  const files = [...new Set([...ws.uncommitted.files, ...ws.uncommitted.untracked])].filter(Boolean);',
    tests: [
      'test/e2e/actions.test.mjs', 'test/e2e/cli.test.mjs',
      'test/e2e/git-execution-boundary.test.mjs',
    ],
  },
  {
    id: 'fail-open-unknown',
    defect: 'an unscannable workstream is reported SAFE instead of unknown (fail-open)',
    file: 'src/analyze.mjs',
    find: "      return { id: w.id, path: w.path, safe: false, confidence: 'unknown', prunable: !!w.prunable, reasons: [w.reason ?? 'not scanned'] };",
    replace: "      return { id: w.id, path: w.path, safe: true, confidence: 'unknown', prunable: !!w.prunable, reasons: [w.reason ?? 'not scanned'] };",
    tests: ['test/e2e/detection.test.mjs', 'test/e2e/break-it.test.mjs'],
  },
  {
    id: 'allowlist-open',
    defect: 'the git allowlist permits everything — holt could run any command',
    file: 'src/git.mjs',
    find: "  return { allowed: false, reason: `'git ${sub}' is not on holt's allowlist` };",
    replace: "  return { allowed: true, tier: 'SAFE' };",
    tests: ['test/unit/safety.test.mjs'],
  },
  {
    id: 'mutation-default-on',
    defect: 'mutating git commands are reachable WITHOUT an explicit opt-in',
    file: 'src/git.mjs',
    find: 'export function classify(argv, { allowMutation = false } = {}) {',
    replace: 'export function classify(argv, { allowMutation = true } = {}) {',
    tests: ['test/e2e/actions.test.mjs', 'test/unit/safety.test.mjs'],
  },
  {
    id: 'no-positional-check',
    defect: 'write forms that differ from reads only by positional count slip through',
    file: 'src/git.mjs',
    find: '  const limit = POSITIONAL_LIMITS[sub];',
    replace: '  const limit = undefined; const _unused = POSITIONAL_LIMITS[sub];',
    tests: ['test/unit/safety.test.mjs'],
  },
  {
    id: 'git-conversion-programs-not-neutralized',
    defect: 'Git commands bypass the repository-program preflight, so status, hashing, checkout and synthetic merge can execute attacker-configured programs',
    file: 'src/git.mjs',
    find: '  const commandContext = await buildGitCommandContext(\n    argv, cwd, env, timeout, executable, executableArgs,\n  );',
    replace: '  const commandContext = { env: buildGitEnv(env), programs: { filterPrefixes: [], checkinFilterPrefixes: [], checkinFilterKeys: [], checkoutFilterPrefixes: [], checkoutFilterKeys: [], mergeDriverKeys: [] } }; // mutated: repository conversion programs retain execution authority',
    tests: ['test/e2e/git-execution-boundary.test.mjs'],
  },
  {
    id: 'git-custom-merge-driver-trusted',
    defect: 'merge-tree proceeds under a repository-configured custom merge program, so attacker output is trusted as committed-delta evidence',
    file: 'src/git.mjs',
    find: "  if (argv[subcommandIndex(argv)] === 'merge-tree' && programs.mergeDriverKeys.length > 0) {",
    replace: '  if (false) { // mutated: external merge program is allowed to own the instrument',
    tests: ['test/e2e/git-execution-boundary.test.mjs'],
  },
  {
    id: 'git-checkout-filter-semantics-invented',
    defect: 'working-tree materialisation suppresses an external smudge/process program but proceeds with canonical blobs, silently testing bytes users would never receive',
    file: 'src/git.mjs',
    find: '  if (commandMaterializesWorkingTree(argv) && programs.checkoutFilterKeys.length > 0) {',
    replace: '  if (false) { // mutated: checkout continues under invented conversion semantics',
    tests: ['test/e2e/git-execution-boundary.test.mjs'],
  },
  {
    id: 'git-checkin-filter-semantics-invented',
    defect: 'a synthetic index is authored after suppressing its clean/process program, so collision analysis trusts a tree Git would not actually create',
    file: 'src/git.mjs',
    find: '  if (commandAuthorsConvertedContent(argv) && programs.checkinFilterKeys.length > 0) {',
    replace: '  if (false) { // mutated: authored content proceeds under invented clean semantics',
    tests: ['test/e2e/git-execution-boundary.test.mjs'],
  },
  {
    id: 'git-cat-file-filter-program-allowed',
    defect: 'cat-file conversion modes cross the safe-read allowlist and execute repository smudge or textconv programs',
    file: 'src/git.mjs',
    find: "  'cat-file': new Set(['--filters', '--textconv']),",
    replace: "  'cat-file': new Set(), // mutated: program-bearing conversion modes are classified SAFE",
    tests: ['test/e2e/git-execution-boundary.test.mjs', 'test/unit/safety.test.mjs'],
  },
  {
    id: 'index-filter-semantics-invented',
    defect: 'assume-unchanged paths with external filter attributes are hashed under disabled semantics and reported exact instead of unmeasured',
    file: 'src/scan.mjs',
    find: '  const filterDependent = filterAttrs.paths;',
    replace: '  const filterDependent = new Set(); // mutated: external filter semantics are treated as builtin identity',
    tests: ['test/e2e/git-execution-boundary.test.mjs'],
  },
  {
    id: 'status-filter-checks-reported-paths-only',
    defect: 'filter uncertainty is queried only for paths already emitted by disabled-filter status, so a filter that changes raw-index-equal bytes disappears as clean',
    file: 'src/scan.mjs',
    find: '  const statusFilterAttrs = await trackedExternalFilterPaths(\n    wtPath, status.externalCheckinFilterDrivers ?? [], { timeout },\n  );',
    replace: '  const statusFilterAttrs = await filterAttributedPaths(\n    wtPath, [...new Set(files)], { timeout, drivers: status.externalCheckinFilterDrivers ?? [] },\n  ); // mutated: status silence chooses the attribute query set',
    tests: ['test/e2e/git-execution-boundary.test.mjs'],
  },
  {
    id: 'rescue-raw-capture-filters-enabled',
    defect: 'rescue hashes sole-copy filesystem bytes through Git conversion, so line endings and other built-in attributes can alter the supposedly exact capture',
    file: 'src/actions.mjs',
    find: "  const r = await gitOk(['hash-object', '-w', '--no-filters', '--stdin'],",
    // Merely removing `--no-filters` is an equivalent mutant: anonymous stdin has no pathname,
    // so Git has no `.gitattributes` context and still hashes the raw bytes. Bind the rescued
    // pathname as the real regression would; now the configured clean/EOL conversion is capable
    // of rewriting the sole copy and the public rescue test must catch both execution and drift.
    replace: "  const r = await gitOk(['hash-object', '-w', `--path=${leaf.path}`, '--stdin'], // mutated: path-bound conversion can rewrite rescue bytes",
    tests: ['test/e2e/git-execution-boundary.test.mjs'],
  },
  {
    id: 'restored-mode-read-from-stale-path-stat',
    defect: 'restored bytes are descriptor-bound but executable mode is inherited from an earlier pathname observation on a replaced inode',
    file: 'src/actions.mjs',
    find: '    const executable = (stable.stat.mode & 0o111) !== 0;',
    replace: '    const executable = (st.mode & 0o111) !== 0; // mutated: stale inode supplies mode',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'clean-no-recheck',
    defect: 'clean acts on a stale verdict instead of re-verifying (TOCTOU)',
    file: 'src/actions.mjs',
    find: '    if (!still?.safe) {',
    replace: '    if (false) {',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'clean-move-replaced-by-remove',
    defect: 'the terminal same-filesystem rename is replaced by recursive Git removal, so bytes written after the final verdict are erased',
    file: 'src/actions.mjs',
    find: "  const moved = await git(['worktree', 'move', '-f', '-f', candidate.path, q.path],",
    replace: "  const moved = await git(['worktree', 'remove', '-f', '-f', candidate.path], // mutated: destructive removal returns",
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'clean-pre-move-lock-omitted',
    defect: 'an unlocked worktree enters quarantine without first acquiring the durable Git lock that prevents a concurrent double-force removal',
    file: 'src/actions.mjs',
    find: '  if (!initialLock.locked) {',
    replace: '  if (false) { // mutated: pre-move quarantine lock omitted',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'clean-binding-basename-only',
    defect: 'worktree identity is reduced to the admin-directory basename, so a different checkout recreated at the same path can inherit an earlier disposable verdict',
    file: 'src/actions.mjs',
    find: "const sameWorktreeBinding = (a, b) => !!a && !!b\n  && samePathSync(a.adminDir, b.adminDir)\n  && a.device === b.device\n  && a.inode === b.inode;",
    replace: "const sameWorktreeBinding = (a, b) => !!a && !!b\n  && path.basename(a.adminDir) === path.basename(b.adminDir); // mutated: basename is treated as identity",
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'clean-quarantine-marker-invisible',
    defect: 'completed quarantine markers are ignored, so generic inspection calls the retained recovery copy disposable again',
    file: 'src/discover.mjs',
    find: '    const quarantine = await cleanQuarantineRecord(w.path, w.lockReason);',
    replace: '    const quarantine = null; // mutated: durable quarantine state is invisible',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'clean-branch-ref-deleted',
    defect: 'cleanup deletes the moved worktree branch ref even though quarantine promises the full registered branch remains recoverable',
    file: 'src/actions.mjs',
    find: "  const branch = actualBranch?.code === 0 ? actualBranch.stdout.trim() : null;",
    replace: "  const branch = actualBranch?.code === 0 ? actualBranch.stdout.trim() : null;\n  if (branch) await git(['update-ref', '-d', `refs/heads/${branch}`], { cwd, allowMutation: true }); // mutated: branch history deleted",
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'purge-forces-late-work-away',
    defect: 'purge adds --force at the final Git boundary, so bytes written after Holt verifies cleanliness are physically erased instead of making Git refuse and Holt restore the lock',
    file: 'src/actions.mjs',
    find: "  const removed = await git(['worktree', 'remove', actualPath], { cwd, allowMutation: true })",
    replace: "  const removed = await git(['worktree', 'remove', '-f', actualPath], { cwd, allowMutation: true }) // mutated: late bytes may be erased",
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'purge-ignores-ignored-sole-copy-bytes',
    defect: 'purge omits ignored paths from its cleanliness evidence, so a gitignored sole-copy file can be treated as disposable and physically removed',
    file: 'src/actions.mjs',
    find: "    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching',",
    replace: "    'status', '--porcelain=v1', '-z', '--untracked-files=all', // mutated: ignored bytes invisible",
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'clean-failure-falls-back-rm',
    defect: 'a refused Git move falls back to recursively deleting the source directory, erasing populated submodules and any other unmovable content',
    file: 'src/actions.mjs',
    find: '  if (moved.code !== 0 && !physicallyMoved) {',
    replace: '  if (moved.code !== 0 && !physicallyMoved) {\n    await fs.rm(candidate.path, { recursive: true, force: true }); // mutated: fallback destroyer',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'protect-nothing',
    defect: 'protect() locks nothing, so --force destroys work again',
    file: 'src/actions.mjs',
    find: "  const shouldProtect = report.safe.filter((s) => !s.safe && s.confidence !== 'unknown');",
    replace: '  const shouldProtect = [];',
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'three-dot-instrument',
    defect: 'the committed delta uses `diff base...head`, which over-reports stranded work',
    file: 'src/scan.mjs',
    find: '    mt = await gitRunner([\'merge-tree\', \'--write-tree\', baseOid, headOid], { cwd: root, timeout });',
    replace: '    mt = { code: 2, stdout: \'\', stderr: \'mutated\' };',
    tests: ['test/e2e/detection.test.mjs'],
  },
  {
    id: 'no-discriminative-filter',
    defect: 'boilerplate symbols are not filtered, so every pair looks related',
    file: 'src/analyze.mjs',
    find: '    if (n <= limit) keep.add(k);',
    replace: '    keep.add(k); if (false) keep.delete(k);',
    tests: ['test/e2e/break-it.test.mjs'],
  },
  {
    id: 'license-signature-blind',
    defect: 'the Ed25519 check always passes — any forged or edited license is accepted',
    file: 'src/license.mjs',
    find: "  if (!ok) return { valid: false, code: 'bad-signature', reason: 'signature does not match — this license was edited or forged' };",
    replace: '  ok = true;',
    tests: ['test/unit/license.test.mjs'],
  },
  {
    id: 'license-entitle-all',
    defect: 'every entitlement check returns true — paid features are ungated for everyone',
    file: 'src/license.mjs',
    find: "  const need = FEATURE_TIER[feature];\n  if (!need) return { entitled: true, tier: 'free', feature, reason: 'this feature is free' };",
    replace: "  const need = FEATURE_TIER[feature];\n  return { entitled: true, tier: 'enterprise', feature, reason: 'mutated' };",
    tests: ['test/unit/license.test.mjs'],
  },
  {
    id: 'license-never-expires',
    defect: 'expiry is ignored, so a lapsed license works forever',
    file: 'src/license.mjs',
    find: '  if (expired && !inGrace) {',
    replace: '  if (false) {',
    tests: ['test/unit/license.test.mjs'],
  },
  {
    id: 'policy-silent-pass',
    defect: 'an unparseable policy file is ignored instead of refusing — the team believes rules ran',
    file: 'src/team/policy.mjs',
    find: "    refuse('POLICY_PARSE', `${label} is not valid JSON/JSONC (${errors.length} parse error(s)) — refusing to run with a policy nobody can read`);",
    replace: "    return { version: 1, rules: [{ id: 'mutated-silent-pass', type: 'no-unlanded', enabled: false }] }; // mutated: unreadable policy silently passes",
    tests: ['test/unit/policy.test.mjs'],
  },
  {
    id: 'policy-reads-symbol-keys',
    defect: 'protected-paths matches globs against symbol IDENTITIES again (callable:foo), so the '
      + 'rule silently passes on every real repository — a green build from a rule that never ran',
    file: 'src/team/policy.mjs',
    find: "        const files = pathsCarriedBy(u, ['uncommitted', 'untracked']);",
    replace: "        const files = [...(u.byLayer?.uncommitted ?? []), ...(u.byLayer?.untracked ?? [])]\n"
      + "          .map((x) => x.path ?? x.key ?? '').filter(Boolean);",
    tests: ['test/e2e/team.test.mjs', 'test/unit/policy.test.mjs'],
  },
  {
    id: 'fleet-counts-worktrees',
    defect: 'the fleet keys repositories by directory path again, so every linked worktree counts '
      + 'as another repository and every total it reports is inflated',
    file: 'src/team/fleet.mjs',
    find: '    const id = await repoIdentity(p);',
    replace: '    const id = null; // mutated: no repository identity, one row per directory',
    tests: ['test/e2e/team.test.mjs'],
  },
  {
    id: 'unprotect-unjournalled',
    defect: 'releasing protection leaves no audit line, so the journal asserts a safer state than '
      + 'the repository is in — a hole exactly where the risky action is',
    file: 'src/actions.mjs',
    find: '    if (r.code === 0) {',
    replace: '    if (false) {',
    tests: ['test/e2e/team.test.mjs'],
  },
  {
    id: 'journal-anonymous',
    defect: 'journal entries lose their actor, so an audit trail records what and when but never who',
    file: 'src/journal.mjs',
    find: '        actor: normaliseActorForJournal(actor ?? currentActor()),',
    replace: '        // mutated: actor dropped',
    tests: ['test/e2e/team.test.mjs'],
  },
  {
    id: 'actor-invented',
    defect: 'an absent identity is guessed at instead of recorded as unknown — a fabricated actor '
      + 'in an audit log is indistinguishable from a real one',
    file: 'src/journal.mjs',
    find: "    source: override ? 'HOLT_ACTOR' : (agent?.source ?? 'unknown'),",
    replace: "    source: override ? 'HOLT_ACTOR' : (agent?.source ?? 'probably-a-human'),",
    tests: ['test/unit/journal.test.mjs'],
  },
  {
    id: 'gate-policy-from-worktree',
    defect: 'the gate reads .holt/policy.json from the WORKING TREE, so a pull request that '
      + 'deletes or weakens it is judged by its own edited copy',
    file: 'src/team/policy.mjs',
    find: '  const fromBase = await loadPolicyFromRef(root, base?.oid);',
    replace: '  const fromBase = { found: false }; // mutated: skip base read',
    tests: ['test/unit/policy.test.mjs', 'test/e2e/ci-gate.test.mjs'],
  },
  {
    id: 'gate-untrusted-policy-suppresses-flags',
    defect: 'a policy the base never carried can switch off --fail-on-unlanded — the same bypass '
      + 'as editing the policy, through the door of ADDING one',
    file: 'src/team/policy.mjs',
    find: '  const carried = trusted === true ? [] : [...flagFailures];',
    replace: '  const carried = [];',
    tests: ['test/unit/policy.test.mjs'],
  },
  {
    id: 'shallow-history-passes',
    defect: 'a shallow or grafted checkout yields an empty audit and the gate reports GREEN — '
      + 'the moment holt knows least is the moment it is most reassuring',
    file: 'src/git.mjs',
    find: "  if (shallow) {\n    return {\n      complete: false,\n      kind: 'shallow',",
    replace: "  if (false) {\n    return {\n      complete: false,\n      kind: 'shallow',",
    tests: ['test/e2e/ci-gate.test.mjs'],
  },
  {
    id: 'webhook-signature-blind',
    defect: 'Stripe webhook signatures are not checked — anyone can POST an event and mint a license',
    file: 'server/index.mjs',
    find: "      if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, timestamp: t };",
    replace: "      return { ok: true, timestamp: t };",
    tests: ['test/unit/server.test.mjs'],
  },
  {
    id: 'webhook-replay-open',
    defect: 'the replay window is gone — a captured genuine event can be replayed forever',
    file: 'server/index.mjs',
    find: '  if (age > toleranceSec) return { ok: false, reason: `event timestamp is ${Math.round(age)}s old — outside the ${toleranceSec}s replay window` };',
    replace: '  // mutated: no replay window',
    tests: ['test/unit/server.test.mjs'],
  },
  {
    id: 'price-defaults-to-paid',
    defect: 'an unknown Stripe price silently issues a team license instead of refusing',
    file: 'server/index.mjs',
    find: "  return { tier: null, via: null, reason: price ? `price ${price} is not in HOLT_PRICE_MAP` : 'no price or tier metadata on the event' };",
    replace: "  return { tier: 'team', via: 'mutated-default' };",
    tests: ['test/unit/server.test.mjs'],
  },
  {
    id: 'checkout-price-injection',
    defect: 'a raw price id in the checkout query is honoured instead of resolving by plan name',
    file: 'server/index.mjs',
    find: "  const price = [...priceMap.entries()].find(([, tier]) => tier === plan)?.[0];\n  if (!price) return { ok: false, reason: `no price configured for plan '${plan}'` };",
    replace: "  const price = plan;\n  if (!price) return { ok: false, reason: 'x' };",
    tests: ['test/unit/server.test.mjs'],
  },
  {
    id: 'roi-inflates',
    defect: 'the ROI summary counts protects as prevented losses, inflating the safety number',
    file: 'src/roi.mjs',
    find: '  const preventedLosses = blocked + rescued;',
    replace: '  const preventedLosses = blocked + rescued + protectedWt;',
    tests: ['test/unit/roi.test.mjs'],
  },
  {
    id: 'order-loses-colocated',
    defect: 'landing order reverts to the human-filtered collisions, so co-located workstreams sequence in parallel and break on apply',
    file: 'src/order.mjs',
    find: '  for (const c of report.collisionsAll ?? report.collisions ?? []) {',
    replace: '  for (const c of report.collisions ?? []) {',
    tests: ['test/unit/order.test.mjs'],
  },
  {
    id: 'discard-ref-clobber',
    defect: 'a discard capture ref is written unconditionally, so a second discard destroys the first capture',
    file: 'src/actions.mjs',
    find: "    allocated = await captureRef(ws.path, {\n      baseRef, commit: captureCommit, tree: captureTree, kind: 'discard', id: ws.id,\n    });",
    replace: "    await gitOk(['update-ref', '--create-reflog', baseRef, captureCommit], { cwd: ws.path, allowMutation: true });\n    allocated = { ok: true, ref: baseRef, commit: captureCommit }; // mutated: unconditional write",
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'rescue-ref-clobber',
    defect: 'a reused worktree id silently overwrites an earlier rescue ref — destroying a capture',
    file: 'src/actions.mjs',
    find: "git(['update-ref', '--create-reflog', ref, commit, ''],",
    replace: "git(['update-ref', '--create-reflog', ref, commit],",
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'idempotency-race',
    defect: 'the event lock is bypassed, so concurrent deliveries of one payment can mint two licenses',
    file: 'server/index.mjs',
    find: '        const outcome = await withEventLock(event.id, dataFile, async () => {',
    replace: '        const outcome = await (async () => {',
    tests: ['test/e2e/purchase-path.test.mjs'],
  },
  {
    id: 'resend-rate-limit-open',
    defect: 'the resend endpoint loses its rate limit — a mail-sending endpoint becomes a spam cannon at our own customers',
    file: 'server/index.mjs',
    find: "        const rl = resendLimiter.take(clientIp(req));\n        if (!rl.allowed) return send(429, { ok: false, reason: 'slow down' }, { ...cors, 'Retry-After': String(rl.retryAfterSec) });",
    replace: "        const rl = { allowed: true };",
    tests: ['test/e2e/purchase-path.test.mjs'],
  },
  {
    id: 'forbidden-open',
    defect: 'the destructive first gate is dead — reset/stash/checkout rely on the allowlist fallthrough alone',
    file: 'src/git.mjs',
    find: '  if (DESTRUCTIVE_ALWAYS.has(sub)) {',
    replace: '  if (false) {',
    tests: ['test/unit/safety.test.mjs'],
  },
  {
    id: 'stash-sweep-uncovered',
    defect: 'the pathspec exemption swallows EVERY stash push, not only scoped ones — bare `git stash` '
      + 'goes back to an unconditional allow, the exact incident this rule exists to stop',
    file: 'src/agent.mjs',
    find: '    unless: (c) => stashHasPathspec(c),',
    replace: '    unless: () => true, // mutated: stash sweep rule never fires',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'stash-ask-cap-removed',
    defect: '`git stash pop` (the recovery action) goes back to a flat deny, and a bare sweeping '
      + '`git stash` on dirty work escalates from ask to deny — over-refusal replacing the honest answer',
    file: 'src/agent.mjs',
    find: "  if (hit.verdict === 'ask') {",
    replace: '  if (false) {',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'redundancy-ignores-durability',
    defect: 'redundancy is claimed against UNCOMMITTED siblings (durableOnly:false), authorising '
      + 'deletion of a worktree whose only twin has not committed the work — the twin can be erased '
      + 'by a git checkout, editor revert or agent write that holt never sees or gates, and the work '
      + 'is lost. The durability bar (durableOnly:true) is the entire reason redundancy can authorise '
      + 'a deletion without losing work.',
    file: 'src/analyze.mjs',
    find: 'const committedCoverage = siblingCoverage(w, committedFiles, { durableOnly: true });',
    replace: 'const committedCoverage = siblingCoverage(w, committedFiles, { durableOnly: false });',
    tests: ['test/e2e/detection.test.mjs', 'test/e2e/actions.test.mjs'],
  },
  {
    id: 'raw-authority-normalizes-whitespace',
    defect: 'deletion identity uses the whitespace-normalized digest, fusing YAML, Make, Markdown, line endings and invalid-byte variants whose exact bytes differ',
    file: 'src/content-identity.mjs',
    find: '  return fp.raw ? `r:${fp.raw}` : null;',
    replace: '  return fp.normalized ? `n:${fp.normalized}` : (fp.raw ? `r:${fp.raw}` : null); // mutated: similarity becomes authority',
    tests: ['test/unit/content-identity.test.mjs', 'test/e2e/destructive-authority.test.mjs'],
  },
  {
    id: 'durable-identity-drops-path',
    defect: 'durable copies are keyed by object identity without their path, so equal bytes at different paths authorize deletion of the only copy of each pathname',
    file: 'src/analyze.mjs',
    find: '  const compound = (file, key) => (file && key ? `${file}\\0${key}` : null);',
    replace: '  const compound = (_file, key) => (key ? key : null); // mutated: path-blind deletion authority',
    tests: ['test/e2e/destructive-authority.test.mjs', 'test/e2e/actions.test.mjs'],
  },
  {
    id: 'durable-identity-drops-mode-type',
    defect: 'the committed identity keeps only the blob oid, so regular, executable and symlink entries with equal bytes become interchangeable deletion backups',
    file: 'src/scan.mjs',
    find: '      entries[file] = `${prefix}${meta[1]}:${meta[2]}:${meta[3]}`;',
    replace: '      entries[file] = `${prefix}${meta[3]}`; // mutated: mode and object type omitted',
    tests: ['test/e2e/destructive-authority.test.mjs'],
  },
  {
    id: 'committed-deletion-tombstone-dropped',
    defect: 'a committed deletion is treated as an unreadable path rather than exact work, so a sibling preserving that deletion cannot relax a redundant worktree',
    file: 'src/scan.mjs',
    find: '    if (!before[file]) entries[file] = `delete:${meta[1]}:${meta[2]}:${meta[3]}`;',
    replace: '    if (false) entries[file] = `delete:${meta[1]}:${meta[2]}:${meta[3]}`; // mutated: deletion intent omitted',
    tests: ['test/e2e/destructive-authority.test.mjs'],
  },
  {
    id: 'committed-name-enumerator-fails-open',
    defect: 'merge-tree succeeds but changed-path enumeration fails, and the empty failure result is trusted as a clean committed delta',
    file: 'src/scan.mjs',
    find: "      'merge-tree-failed', 'merge-tree-no-tree', 'merge-tree-names-failed',",
    replace: "      'merge-tree-failed', 'merge-tree-no-tree', // mutated: name enumeration failure is an all-clear",
    tests: ['test/e2e/destructive-authority.test.mjs'],
  },
  {
    id: 'line-ending-similarity-authorizes-delete',
    defect: 'a line-ending-only comparison to base suppresses the exact committed-delta refusal, treating changed Git bytes as recoverable',
    file: 'src/analyze.mjs',
    find: '    if (risk.committedCount > 0 && heldAlsoBy.length === 0) {',
    replace: '    if (risk.committedCount > 0 && heldAlsoBy.length === 0 && !w.committed?.lineEndingOnlyVsBase) { // mutated: advisory similarity becomes authority',
    tests: ['test/e2e/destructive-authority.test.mjs', 'test/e2e/actions.test.mjs'],
  },
  {
    id: 'generated-paths-erased-from-risk',
    defect: 'the status reader drops generated-looking names, so hand-patched dependencies, lockfiles and incident logs disappear before either scan or guard can protect them',
    file: 'src/scan.mjs',
    find: "    if (xy === '!!') out.set(p, 'gitignored');",
    replace: "    if (looksGenerated(p, _activeDirs)) continue; // mutated: a name erases evidence\n    if (xy === '!!') out.set(p, 'gitignored');",
    tests: ['test/e2e/destructive-authority.test.mjs', 'test/e2e/integration.test.mjs'],
  },
  {
    id: 'empty-ignored-directory-counted-as-work',
    defect: 'a recursively empty ignored directory is retained as unique work, so harmless cleanup is refused and the full-product treatment intervenes where the control does not',
    file: 'src/scan.mjs',
    find: "    if (await ignoredDirectoryContentState(abs) !== 'empty') kept.push(entry);",
    replace: "    kept.push(entry); // mutated: empty directory topology is called sole-copy content",
    tests: ['test/e2e/empty-ignored-directory.test.mjs', 'test/e2e/resolution.test.mjs'],
  },
  {
    id: 'same-command-composed-literal-dropped',
    defect: 'a literal assignment composed from an earlier literal in the same command remains opaque, so the guard asks or judges the wrong worktree despite having the exact value',
    file: 'src/agent.mjs',
    find: "      const expanded = m[2].replace(\n        /(?<!\\\\)\\$\\{?([A-Za-z_][A-Za-z0-9_]*)\\}?/g,\n        (whole, name) => values.has(name) ? values.get(name) : whole,\n      );",
    replace: "      const expanded = m[2]; // mutated: earlier literal assignments are not composed",
    tests: ['test/e2e/integration.test.mjs', 'test/e2e/resolution.test.mjs'],
  },
  {
    id: 'scoped-git-clean-judges-whole-tree',
    defect: 'a pathspec-scoped git clean falls back to the whole worktree verdict, citing unrelated sole-copy files the command cannot reach',
    file: 'src/agent.mjs',
    find: "    if (verb !== 'checkout' && verb !== 'restore' && verb !== 'clean') continue;",
    replace: "    if (verb !== 'checkout' && verb !== 'restore') continue; // mutated: clean pathspec never narrows authority",
    tests: ['test/e2e/integration.test.mjs', 'test/e2e/resolution.test.mjs'],
  },
  {
    id: 'discard-refuses-empty-directory',
    defect: 'one empty nested directory makes the verified discard path refuse an otherwise recoverable package tree, dead-ending the documented remediation',
    file: 'src/actions.mjs',
    find: "  for (const name of names) {\n    const childLogical = `${logicalPath}/${name}`;",
    replace: "  if (names.length === 0) throw new Error(`'${logicalPath}' is an empty directory and cannot be represented in Git`); // mutated: ordinary generated topology dead-ends cleanup\n  for (const name of names) {\n    const childLogical = `${logicalPath}/${name}`;",
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'primary-risk-read-from-nonexistent-count',
    defect: 'primary content reproducibility reads a nonexistent aggregate count, so a prose-only or otherwise symbol-free edit is declared reproducible',
    file: 'src/analyze.mjs',
    find: '      const nothingUnique = !(u0?.uniqueSymbolCount > 0) && risk0.empty;',
    replace: '      const nothingUnique = !(u0?.uniqueSymbolCount > 0) && risk0.count === 0; // mutated: undefined aggregate hides real files',
    tests: ['test/e2e/destructive-authority.test.mjs', 'test/e2e/integration.test.mjs'],
  },
  {
    id: 'nonexistent-output-matches-ignored-parent',
    defect: 'a newly-created output path is treated as overwriting its collapsed ignored parent directory, producing a false destructive verdict for ordinary writes',
    file: 'src/agent.mjs',
    find: "    if (!t.pathspec && !isGlobPattern(raw)\n      && ['delete', 'truncate', 'overwrite'].includes(t.role)\n      && !(await pathExists(abs))) continue;",
    replace: "    if (false) continue; // mutated: nonexistent destinations inherit their ignored parent's bytes",
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'stash-identity-drops-path-mode-type',
    defect: 'stash reachability compares blob ids alone, so a ref holding equal bytes at another path, mode or entry type falsely makes destructive stash drop and clear safe',
    file: 'src/stash.mjs',
    find: "  return `${entry.operation ?? 'present'}\\0${entry.path}\\0${entry.mode}\\0${entry.type}\\0${entry.sha}`;",
    replace: "  return `${entry.operation ?? 'present'}\\0${entry.sha}`; // mutated: path, mode and type discarded",
    tests: ['test/e2e/stash-evidence.test.mjs'],
  },
  {
    id: 'stash-identity-drops-operation',
    defect: 'presence of the old blob at a path is treated as preserving a deletion at that path, so a deletion-only stash is silently droppable',
    file: 'src/stash.mjs',
    find: "  return `${entry.operation ?? 'present'}\\0${entry.path}\\0${entry.mode}\\0${entry.type}\\0${entry.sha}`;",
    replace: '  return `${entry.path}\\0${entry.mode}\\0${entry.type}\\0${entry.sha}`; // mutated: presence and deletion collapse',
    tests: ['test/e2e/stash-evidence.test.mjs'],
  },
  {
    id: 'stash-deletion-candidate-dropped',
    defect: 'a stash holding only a deletion records no candidate content, so drop and clear erase the only copy of that work with a silent allow',
    file: 'src/stash.mjs',
    find: "        else add(rec.srcSha, rec.path, rec.srcMode, type, layer, 'delete');",
    replace: '        else void type; // mutated: deletion intent omitted because there is no destination blob',
    tests: ['test/e2e/stash-evidence.test.mjs'],
  },
  {
    id: 'discard-decodes-binary-as-utf8',
    defect: 'tracked blobs pass through UTF-8 decoding during discard, corrupting invalid bytes while the operation still reports success',
    file: 'src/actions.mjs',
    find: '      if (Buffer.isBuffer(bytes)) content.set(spec, bytes);',
    replace: "      if (Buffer.isBuffer(bytes)) content.set(spec, Buffer.from(bytes.toString('utf8'), 'utf8')); // mutated: binary corruption",
    tests: ['test/e2e/actions.test.mjs'],
  },
  {
    id: 'cache-ignores-ignored-bytes',
    defect: 'the safety cache fingerprints ignored paths but not their bytes, so changing a gitignored secret reuses an old answer',
    file: 'src/agent.mjs',
    find: "const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], { cwd: p })",
    replace: "const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: p })",
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'shell-comment-destroyer-visible',
    defect: 'a destroyer mentioned after an unquoted shell comment is treated as executable command text',
    file: 'src/agent.mjs',
    find: "    if (ch === '#' && (i === 0 || /[\\s;&|(]/.test(s[i - 1]))) {",
    replace: '    if (false) { // mutated: shell comments are scanned as commands',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'bom-command-trusted',
    defect: 'a BOM-prefixed hook command bypasses the parser and is allowed or misclassified instead of asking',
    file: 'src/agent.mjs',
    find: "  if (/^[\\uFEFF\\uFFFE]/.test(command)) {",
    replace: '  if (false) { // mutated: BOM is treated as ordinary input',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'brace-target-allowed',
    defect: 'an unresolved shell brace expansion is treated as a literal path and silently allowed',
    file: 'src/agent.mjs',
    find: "  if (/(?<!\\\\)\\{[^{}\\n]*,[^{}\\n]*\\}/.test(value)) {",
    replace: '  if (false) { // mutated: brace expansion is silently accepted',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'compound-second-match-unseen',
    defect: 'only the first destructive match in a compound command is assessed, so an ask or allow can disarm a later deny',
    file: 'src/agent.mjs',
    find: '  for (const hit of structure.matches) {',
    replace: '  for (const hit of structure.matches.slice(0, 1)) {',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'malformed-hook-allowed',
    defect: 'a malformed or empty pre-tool hook payload falls through to the allow path',
    file: 'bin/holt.mjs',
    find: "    if (payloadError) {\n      const verdict = {\n        decision: 'ask',\n        reason: `holt could not parse the hook payload (${payloadError.message}). Confirm the command manually before proceeding.`,\n      };\n      emitHookVerdict(verdict, opts, { cwd });\n    }",
    replace: "    if (payloadError) {\n      out(JSON.stringify(formatVerdict({ decision: 'allow', reason: null }, { host: opts.host })));\n      return; // mutated: malformed payload silently allowed\n    }",
    tests: ['test/e2e/cli.test.mjs'],
  },
  {
    // RE-ANCHORED, because the behaviour moved. The command-wide `cwd = commandCwd` no longer
    // decides anything for a matched verb: each match is resolved against the `cd` AND `git -C` in
    // effect at ITS OWN position (matchWorkingDirectory), so deleting the old line stopped
    // simulating the defect and the mutant went green while the code was still guarded. The defect
    // is the same one — "the verb is judged in the caller's directory instead of its own" — pinned
    // at the line that now owns it, which also covers the `git -C <subdir>` half.
    id: 'cd-worktree-layer-ignored',
    defect: 'content verbs ignore the cd / git -C in effect at their own position and are judged in the caller directory instead',
    file: 'src/agent.mjs',
    find: '    const { dir, cUnresolved } = matchWorkingDirectory(command, callerCwd, hit.index ?? 0);',
    replace: '    const { dir, cUnresolved } = { dir: callerCwd, cUnresolved: false }; // mutated: the verb runs where the caller stands',
    tests: ['test/e2e/integration.test.mjs', 'test/e2e/resolution.test.mjs'],
  },
  {
    id: 'c-flag-subdir-not-contained',
    defect: 'a path-less verb redirected into a SUBDIRECTORY of a worktree resolves by exact path only, finds nothing, and is allowed',
    file: 'src/agent.mjs',
    find: '      ? [await containingWorkstream(report, cwd)].filter(Boolean)',
    replace: '      ? [await findWorkstream(report, cwd, cwd)].filter(Boolean) // mutated: exact path, never containment',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'unterminated-quote-allowed',
    defect: 'a command that ends inside an unterminated quote or heredoc is reported as harmless instead of unread',
    file: 'src/agent.mjs',
    find: '  if (parseIncomplete(command)) {',
    replace: '  if (false) { // mutated: an unparsed tail is treated as data',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'heredoc-swallows-next-command',
    defect: 'skipping a heredoc body does not close the segment, so the command AFTER the terminator is absorbed and its target dropped',
    file: 'src/agent.mjs',
    find: "      if (sk.kind === 'heredoc') flushSeg(sk.end); else flushWord();",
    replace: '      flushWord(); // mutated: the heredoc body merges with what follows it',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'live-expansion-read-as-literal',
    defect: 'a live $VAR is treated as a literal filename, so an unresolvable target resolves to a bogus path that matches no worktree and is allowed',
    file: 'src/agent.mjs',
    find: 'function looksLikeExpansion(rawTarget) {\n  if (rawTarget == null) return false;',
    replace: 'function looksLikeExpansion(rawTarget) {\n  if (rawTarget != null) return false; // mutated: every dollar is a literal character',
    tests: ['test/e2e/resolution.test.mjs', 'test/e2e/integration.test.mjs'],
  },
  {
    id: 'unresolved-variable-not-reported',
    defect: 'an unbounded target still carrying a shell expansion is resolved literally instead of reported, turning an ask into a silent allow',
    file: 'src/agent.mjs',
    find: '    if (!GLOBBY.test(value)) {',
    replace: '    if (false) { // mutated: a residual expansion is never reported as unresolved',
    tests: ['test/e2e/resolution.test.mjs', 'test/e2e/integration.test.mjs'],
  },
  {
    id: 'subshell-parens-glued-to-words',
    defect: 'subshell parens are read as ordinary path characters, so a `cd` inside `( … )` is invisible and its target is truncated — both silent allows',
    file: 'src/agent.mjs',
    find: "    if (ch === '(' || ch === ')') { flushSeg(i); continue; }",
    replace: '    if (false) { continue; } // mutated: parens are ordinary path characters',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'git-c-only-first-applied',
    defect: 'only the first `git -C` is applied, so a command with repeated -C is judged in a directory git never enters',
    file: 'src/agent.mjs',
    find: '      dir = dir === null ? v : combinePath(dir, v);',
    replace: '      dir = dir === null ? v : dir; // mutated: later -C values are dropped',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'comment-boundary-paren-ignored',
    defect: '`#` after `(` is not read as a comment, so an apostrophe inside it opens a quote that masks the destroyer on the next line',
    file: 'src/agent.mjs',
    find: "    if (ch === '#' && (i === 0 || /[\\s;&|(]/.test(s[i - 1]))) {",
    replace: "    if (ch === '#' && (i === 0 || /[\\s;&|]/.test(s[i - 1]))) { // mutated: ( is not a word boundary",
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    // THE MUTANT THE PREVIOUS ROUND WAS MISSING. `heredoc-swallows-next-command` pins the segment
    // BOUNDARY; reverting it never surfaced the case where the body itself is a script. So the
    // silent allow shipped: `. /dev/stdin <<'EOF' … rm -rf ../wt-a … EOF` came back allow with an
    // empty target list, while the identical rm typed on one line denied.
    id: 'heredoc-executor-read-as-prose',
    defect: 'a heredoc body is masked as a document even when its consumer EXECUTES it, so a destroyer written into a shell on stdin is invisible',
    file: 'src/agent.mjs',
    find: '        const consumer = heredocConsumesCode(s.slice(cmdStart, bodyStart));',
    replace: '        const consumer = null; // mutated: every body is prose, whoever receives it',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    // ONE CLASSIFICATION, EVERY READER. The tokenizer would still read an unmasked body, so this
    // mutant is only killable by a verb the FILE layer cannot see — `git reset --hard`,
    // `git worktree remove`, `git clean` — which is exactly what the test asserts.
    id: 'executed-heredoc-masked-from-verb-layer',
    defect: 'the verb layer masks a heredoc its own scanner classified as code, so a worktree-only destroyer inside it never matches a rule',
    file: 'src/agent.mjs',
    find: "    .filter((r) => r[2] !== 'heredoc-code')",
    replace: '    .filter(() => true) // mutated: an executed body is masked from the verb layer anyway',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'heredoc-consumer-ignores-pipeline',
    defect: 'only the stage the heredoc operator is written against is read, so `cat <<EOF | bash` is judged by the cat and its body is treated as a document',
    file: 'src/agent.mjs',
    find: "    if (c === '|') { stage(); if (text[i + 1] === '|') i++; continue; }",
    replace: '    if (c === \'|\') { break; } // mutated: the rest of the pipeline is not a consumer',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    // TWO READERS OF ONE RULE IS THE DEFECT ITSELF. The tokenizer honours `\` and the mask scanner
    // did not, which cost in both directions at once: ordinary `sed 's/it'\''s/its/'` became
    // "unparseable", and an EVEN number of escaped quotes masked a real `git -C … reset --hard`.
    id: 'escaped-quote-opens-a-mask',
    defect: 'the mask scanner reads a backslash-escaped quote as an opening quote, masking whatever follows it and refusing valid shell',
    file: 'src/agent.mjs',
    find: '      if (backslashEscapes(next, word, hasWord)) { word += next; hasWord = true; i += 2; continue; }',
    replace: '      if (false) { word += next; hasWord = true; i += 2; continue; } // mutated: no escapes for the scanner',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'interpreter-heredoc-program-unread',
    defect: 'an interpreter reads its program from a heredoc and holt reads only the -e/-c form, so `node <<X … rmSync(worktree) … X` is a silent allow',
    file: 'src/agent.mjs',
    find: '      for (const [how, code] of [...flagged, ...bodies]) {',
    replace: '      for (const [how, code] of flagged) { // mutated: only an inline flag carries a program',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'read-heredoc-still-called-unseen',
    defect: 'a shell whose program is a heredoc holt has already READ is still reported as executing input holt cannot see — absence of evidence sold as evidence of absence',
    file: 'src/agent.mjs',
    find: '      const literalProgram = readable.some(([a]) => a >= seg.start && a <= seg.end);',
    replace: '      const literalProgram = false; // mutated: a body holt read is still called unseen',
    tests: ['test/e2e/resolution.test.mjs'],
  },
  {
    id: 'cd-ambiguity-allowed',
    defect: 'cd - and popd are guessed instead of asking when the prior directory is not statically known',
    file: 'src/agent.mjs',
    find: "  if (hasAmbiguousDirectoryChange(command) && (matches.length > 0 || filePaths.length > 0)) {",
    replace: "  if (false) { // mutated: an unknowable cd is guessed instead of asked about",
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'guard-allowlist-ignored',
    defect: 'a human-reviewed guardAllow entry is ignored, so the explicit escape hatch does not work',
    file: 'src/agent.mjs',
    find: '  if (allowlistPattern) {',
    replace: '  if (false) { // mutated: guardAllow is ignored',
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'claude-allow-bypasses-native-permissions',
    defect: 'Claude allow output emits permissionDecision:allow and bypasses the host native permission flow',
    file: 'src/integrate/adapters.mjs',
    find: "  if (host === 'claude-code' || host === 'qwen-code') {\n    if (verdict.decision === 'allow') return {};",
    replace: "  if (host === 'claude-code' || host === 'qwen-code') {\n    if (verdict.decision === 'allow') return { hookSpecificOutput: { hookEventName: eventName, permissionDecision: 'allow' } };",
    tests: ['test/e2e/integration.test.mjs'],
  },
  {
    id: 'host-upgrade-matches-command-only',
    defect: 'a hook with the right Holt command but the wrong matcher or missing Windows action is treated as fully installed, leaving destructive shell calls unguarded',
    file: 'src/integrate/adapters.mjs',
    find: '    const matchedWanted = wanted.findIndex((shape, index) => !covered.has(index)\n      && containsHookShape(entry, shape));',
    replace: '    const matchedWanted = holtCommands.every((command) => canonical.has(command)) ? 0 : -1; // mutated: command text stands in for the host contract',
    tests: ['test/unit/host-hook-contracts.test.mjs'],
  },
  {
    id: 'host-shell-payload-missing-command-allows',
    defect: 'a recognised shell hook payload with a missing/renamed command field falls through as safe, making an installed adapter silently inert after schema drift',
    file: 'bin/holt.mjs',
    find: "      if (!command) {\n        emitHookVerdict({\n          decision: 'ask',\n          reason: `holt received a ${toolName ?? 'shell'} pre-tool event with no command field. `\n            + 'The host payload could not be verified; confirm the command manually before proceeding.',\n        }, opts, { cwd });\n      }",
    replace: "      if (!command) {\n        out(JSON.stringify(formatVerdict({ decision: 'allow', reason: null }, { host: opts.host })));\n        return; // mutated: schema drift silently allowed\n      }",
    tests: ['test/e2e/cli.test.mjs'],
  },
  {
    id: 'policy-uses-truncated-branch-sample',
    defect: 'protected-path policy checks only branchAudit\'s 25-path display sample, so a protected 26th path passes enterprise policy',
    file: 'src/team/policy.mjs',
    find: '        const carried = authoritativeBranchPaths(b);',
    replace: '        const carried = b.files ?? []; // mutated: presentation sample becomes policy authority',
    tests: ['test/unit/policy.test.mjs', 'test/e2e/branches.test.mjs'],
  },
  {
    id: 'managed-policy-accepts-infinite-age',
    defect: 'max-branch-age accepts Infinity, making the enterprise age gate mathematically unable to fail',
    file: 'src/team/policy.mjs',
    find: "&& (typeof r.days !== 'number' || !Number.isFinite(r.days) || r.days <= 0 || r.days > 365_000))",
    replace: "&& (typeof r.days !== 'number' || r.days <= 0 || r.days > 365_000)) /* mutated: Infinity accepted */",
    tests: ['test/unit/managed-policy-schema.test.mjs'],
  },
  {
    id: 'managed-policy-universal-glob-alias',
    defect: 'vacuity detection recognizes a short literal list again, so equivalent universal globs such as *** silently disable a managed rule',
    file: 'src/team/policy.mjs',
    find: "  return ['', '/', 'plain', 'a/b'].every((subject) => safeGlobTest(compiled, subject, budget));",
    replace: "  return new Set(['*', '**', '**/*', '*/**']).has(glob); // mutated: semantic aliases missed",
    tests: ['test/unit/managed-policy-schema.test.mjs'],
  },
  {
    id: 'managed-policy-missing-age-passes',
    defect: 'a branch without age evidence skips max-branch-age instead of failing closed',
    file: 'src/team/policy.mjs',
    find: "        if (typeof b.ageDays !== 'number' || !Number.isFinite(b.ageDays) || b.ageDays < 0) {",
    replace: "        if (false) { // mutated: missing and non-finite age evidence passes",
    tests: ['test/unit/managed-policy-schema.test.mjs'],
  },
  {
    id: 'managed-policy-ignore-suppresses-central',
    defect: 'a repository-controlled ignore list is passed into central managed policy evaluation and suppresses a mandatory rule',
    file: 'src/team/policy.mjs',
    find: '      { audit, report, ignore: [], inlineFailures: [] },',
    replace: '      { audit, report, ignore: lowerIgnore, inlineFailures: [] }, // mutated: repository suppresses central policy',
    tests: ['test/e2e/managed-policy-authority.test.mjs'],
  },
  {
    id: 'managed-policy-repository-swap-unchecked',
    defect: 'a system repository binding is never revalidated, so replacing the enrolled path with a different inode after issuance still produces a managed-policy verdict',
    file: 'src/team/managed-policy-authority.mjs',
    find: "  if (current.realRoot !== binding.realRoot\n    || current.device !== binding.device || current.inode !== binding.inode) {",
    replace: "  if (false) { // mutated: issued repository identity is never revalidated",
    tests: ['test/e2e/managed-policy-authority.test.mjs'],
  },
  {
    id: 'managed-policy-alternate-path-bypasses',
    defect: 'a single-purpose runner silently treats a different checkout path as untargeted and falls through to weaker repository CI',
    file: 'src/team/managed-policy-cli.mjs',
    find: '    const binding = await systemRepositoryIdentityBinding({ storeRoot: fixedStore, profile, repositoryRoot });',
    replace: "    let binding;\n    try {\n      binding = await systemRepositoryIdentityBinding({ storeRoot: fixedStore, profile, repositoryRoot });\n    } catch (error) {\n      if (error?.code === 'MANAGED_POLICY_NOT_TARGETED') continue; // mutated: alternate path bypasses system authority\n      throw error;\n    }",
    tests: ['test/e2e/managed-policy-authority.test.mjs'],
  },
  {
    id: 'managed-policy-missing-assignment-bypasses',
    defect: 'a workspace enrolled by root but omitted from the active signed assignment silently falls through to ordinary CI',
    file: 'src/team/managed-policy-cli.mjs',
    find: '    if (!authority.claimed) {',
    replace: '    if (false) { // mutated: missing signed assignment is accepted',
    tests: ['test/e2e/managed-policy-authority.test.mjs'],
  },
  {
    id: 'managed-policy-shared-runner-guesses-profile',
    defect: 'multiple system profiles are accepted on one runner, reintroducing ambiguous path-based exemptions without authenticated selection',
    file: 'src/team/managed-policy-cli.mjs',
    find: '  if (profiles.length !== 1) {',
    replace: '  if (false) { // mutated: shared multi-profile runner accepted',
    tests: ['test/e2e/managed-policy-authority.test.mjs'],
  },
  {
    id: 'managed-policy-system-bytes-ci-unreadable',
    defect: 'root-owned system policy is made owner-private again, so the ordinary unprivileged CI account cannot evaluate the authority',
    file: 'src/team/managed-policy-store.mjs',
    find: "const managedDirectoryMode = (authority) => authority === 'system' ? 0o755 : 0o700;\nconst managedReadOnlyDirectoryMode = (authority) => authority === 'system' ? 0o555 : 0o500;\nconst managedReadOnlyFileMode = (authority) => authority === 'system' ? 0o444 : 0o400;\nconst managedPointerFileMode = (authority) => authority === 'system' ? 0o644 : 0o600;",
    replace: "const managedDirectoryMode = () => 0o700; // mutated: CI cannot traverse system policy\nconst managedReadOnlyDirectoryMode = () => 0o500;\nconst managedReadOnlyFileMode = () => 0o400;\nconst managedPointerFileMode = () => 0o600;",
    tests: ['test/e2e/managed-policy-authority.test.mjs'],
  },
  {
    id: 'managed-policy-stale-lock-token-ignored',
    defect: 'activation recovery accepts any stale lock token and can clear a replacement transaction owned by another process',
    file: 'src/team/managed-policy-store.mjs',
    find: "    if (typeof lockToken !== 'string' || observed.token !== lockToken) {\n      managedPolicyRefuse(\n        'MANAGED_POLICY_LOCK_OWNERSHIP',\n        `recovery requires the exact currently inspected lock token for profile '${profile}'`,\n      );\n    }\n    await removeOwnedLock(paths, profile, lockToken);",
    replace: "    await removeOwnedLock(paths, profile, observed.token); // mutated: caller token ownership ignored",
    tests: ['test/e2e/managed-policy-authority.test.mjs'],
  },
  {
    id: 'managed-policy-expiry-disabled',
    defect: 'offline authority silently keeps enforcing a forever-last-good policy after authenticated TUF metadata expires',
    file: 'src/team/managed-policy-authority.mjs',
    find: '  if (now >= earliest.milliseconds + expiryGraceMs) {',
    replace: '  if (false) { // mutated: stale managed policy remains authoritative forever',
    tests: ['test/e2e/managed-policy-authority.test.mjs'],
  },
  {
    id: 'managed-policy-refresh-churns-generation',
    defect: 'an identical authenticated refresh is treated as new enforcement state solely because the verifier wall clock changed',
    file: 'src/team/managed-policy-store.mjs',
    find: '      && sameAuthenticatedGeneration(current.generation.activation, staged.activation)) {',
    replace: '      && false) { // mutated: identical refresh always installs another generation',
    tests: ['test/e2e/managed-policy-tuf.test.mjs'],
  },
  {
    id: 'managed-policy-hardlinks-accepted',
    defect: 'managed-policy files with a second mutable pathname are accepted, so bytes can change outside the guarded tree',
    file: 'src/team/managed-policy-store.mjs',
    find: '    if (before.nlink !== 1n) {',
    replace: '    if (false) { // mutated: hardlinked authoritative bytes accepted',
    tests: ['test/e2e/managed-policy-authority.test.mjs'],
  },
  {
    id: 'managed-policy-calendar-normalization-accepted',
    defect: 'impossible signed receipt dates are normalized by Date.parse and enforced as a different instant than the verifier signed',
    file: 'src/team/managed-policy-schema.mjs',
    find: "  if (!match || date === null\n    || date.getUTCFullYear() !== Number(match[1])\n    || date.getUTCMonth() + 1 !== Number(match[2])\n    || date.getUTCDate() !== Number(match[3])\n    || date.getUTCHours() !== Number(match[4])\n    || date.getUTCMinutes() !== Number(match[5])\n    || date.getUTCSeconds() !== Number(match[6])) {",
    replace: '  if (!match || date === null) { // mutated: impossible calendar fields are silently normalized',
    tests: ['test/unit/managed-policy-schema.test.mjs'],
  },
  {
    id: 'managed-policy-arbitrary-system-store',
    defect: 'a caller can label any root-owned directory as machine authority instead of using the one fixed system store',
    file: 'src/team/managed-policy-store.mjs',
    find: '  if (!(await samePathAsync(storeRoot, SYSTEM_MANAGED_POLICY_STORE_ROOT))) {',
    replace: '  if (false) { // mutated: arbitrary store roots may claim production system authority',
    tests: ['test/e2e/managed-policy-authority.test.mjs'],
  },
  {
    id: 'managed-policy-profile-staging-containment-disabled',
    defect: 'attacker-controlled staging inside the active profile is accepted and moved as if it came from the verifier-owned sibling area',
    file: 'src/team/managed-policy-store.mjs',
    find: '  if (!ownedIncoming && await underOrEqualAsync(stagedReal, profileReal)) {',
    replace: '  if (false) { // mutated: staging inside the authoritative profile is accepted',
    tests: ['test/e2e/managed-policy-authority.test.mjs'],
  },
  {
    id: 'journal-evidence-ignores-failed-verification',
    defect: 'a contradictory or failed journal verification is classified from its friendly code instead of ok:false, allowing untrusted audit evidence into enterprise summaries',
    file: 'src/team/fleet.mjs',
    find: "  if (!verification?.ok) return 'tampered-or-unverifiable';",
    replace: "  if (false) return 'tampered-or-unverifiable'; // mutated: ok:false no longer dominates labels",
    tests: ['test/e2e/audit-chain.test.mjs'],
  },
  {
    id: 'audit-writer-reenters-replaced-parent-path',
    defect: 'the audit writer abandons its anchored cwd after readiness and follows the original pathname after a concurrent parent replacement',
    file: 'src/team/audit-sink.mjs',
    find: '  for (const operation of request.operations) {',
    replace: '  process.chdir(expected.path); // mutated: replaced pathname regains write authority\n  for (const operation of request.operations) {',
    tests: ['test/e2e/audit-chain.test.mjs'],
  },
  {
    id: 'stable-regular-file-open-blocks-on-fifo',
    defect: 'descriptor-bound regular-file validation opens a FIFO in blocking mode and hangs before it can reject the node type',
    file: 'src/stable-file.mjs',
    find: '  try { handle = await fs.open(file, FSC.O_RDONLY | NOFOLLOW | NONBLOCK); } catch (error) {',
    replace: '  try { handle = await fs.open(file, FSC.O_RDONLY | NOFOLLOW); } catch (error) { // mutated: FIFO blocks before fstat',
    tests: ['test/unit/stable-file.test.mjs'],
  },
  {
    id: 'fleet-counts-empty-journal-as-verified',
    defect: 'fleet totals trust any syntactically valid or absent journal, so no evidence is reported as verified zero-event compliance',
    file: 'src/team/fleet.mjs',
    find: '        const trusted = hasTrustedJournalEvidence(v);',
    replace: '        const trusted = !!v.ok; // mutated: integrity without populated evidence becomes compliance coverage',
    tests: ['test/e2e/audit-chain.test.mjs'],
  },
  {
    id: 'forensics-attributes-unverified-journal',
    defect: 'single-repository forensics derives actor/action claims from a legacy or tampered journal instead of refusing attribution',
    file: 'src/forensics.mjs',
    find: '  if (!verification.ok || (verification.legacy ?? 0) > 0) throw new ForensicsIntegrityError(verification);',
    replace: '  if (false) throw new ForensicsIntegrityError(verification); // mutated: attribution trusts unverified records',
    tests: ['test/e2e/forensics.test.mjs'],
  },
  {
    id: 'fleet-forensics-correlates-unverified-journal',
    defect: 'cross-repository forensics correlates sessions and destructive actions from a journal whose checkpoint is missing or invalid',
    file: 'src/team/forensics-fleet.mjs',
    find: '      if (!hasTrustedJournalEvidence(verification)) {',
    replace: '      if (false) { // mutated: untrusted records enter fleet attribution',
    tests: ['test/e2e/forensics.test.mjs'],
  },

  /* ---- the supply-chain audit -------------------------------------------------- *
   * These four are the ways a security-evidence tool fails WITHOUT throwing: it keeps
   * printing "✓ 7/7 checks passed" while the property it claims is false. That is the
   * only failure mode that matters for an artefact a buyer acts on, so each mutation
   * below leaves the audit GREEN unless the suite is actually watching.                */
  {
    id: 'sc-network-blind',
    defect: 'the audit stops detecting import-free network globals, so a fetch() added to the analysis engine passes as clean — the exact claim the README makes',
    file: 'src/supply-chain.mjs',
    find: "  if (NETWORK_GLOBALS.test(executableCode(source))) caps.add('network');",
    replace: '  // mutated: fetch()/WebSocket no longer count as network capability',
    tests: ['test/unit/supply-chain.test.mjs'],
  },
  {
    id: 'sc-integrity-fail-open',
    defect: 'a MISSING manifest reports the installation as verified — absent evidence read as good news, which is this project\'s most repeated defect class',
    file: 'src/supply-chain.mjs',
    find: "      ok: false, code: 'no-manifest', signature: 'absent',",
    replace: "      ok: true, code: 'no-manifest', signature: 'absent',",
    tests: ['test/unit/supply-chain.test.mjs'],
  },
  {
    id: 'sc-dynamic-spawn-blind',
    defect: 'subprocesses whose executable is a variable stop being inventoried, so `execFile(anything, …)` never appears in the list a reviewer reads',
    file: 'src/supply-chain.mjs',
    find: "      if (t.startsWith('<dynamic:')) foundSites.add(`${rel}:${t.slice(9, -1)}`);",
    replace: "      if (t.startsWith('<dynamic:')) { /* mutated: dynamic call sites invisible */ }",
    tests: ['test/unit/supply-chain.test.mjs'],
  },
  {
    id: 'sc-ledger-one-way',
    defect: 'a capability declared with no code behind it stops being a finding — the security statement can then outlive the code and become a false claim, exactly as the paid tier once advertised three unbuilt features',
    file: 'src/supply-chain.mjs',
    find: "    for (const c of want) if (!actual.has(c)) staleDeclarations.push({ file: rel, capability: c, kind: 'declared-but-absent' });",
    replace: '    // mutated: declarations are never checked against reality',
    tests: ['test/unit/supply-chain.test.mjs'],
  },
];

export function run(cmd, args, cwd, timeout = 600_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOLT_TMPDIR: process.env.HOLT_TMPDIR ?? undefined },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

export async function applyMutation(work, m) {
  const file = path.join(work, m.file);
  const original = await fs.readFile(file, 'utf8');
  if (!original.includes(m.find)) {
    return { ok: false, original, error: `anchor not found in ${m.file}: ${m.find.slice(0, 70)}` };
  }
  await fs.writeFile(file, original.replace(m.find, m.replace), 'utf8');
  // Re-seal the integrity manifest in the SCRATCH COPY. Without this, every mutation would be
  // "killed" by the manifest-currency test noticing the source changed — a trivial kill that
  // proves nothing about the behaviour under test and hides survivors behind a green number.
  // It is also the realistic threat model: whoever changes a file can recompute a hash list.
  await run(process.execPath, [path.join(work, 'scripts/gen-manifest.mjs')], work, 60_000);
  return { ok: true, original, file };
}

export function classifyMutationResult(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|Cannot use import statement outside a module/i.test(output)) {
    return { outcome: 'invalid', detail: 'mutation caused a syntax or module-loading error' };
  }
  if (result.code === 0) return { outcome: 'survived', detail: 'all tests passed' };
  if (/\bnot ok\b|# fail [1-9]\d*|\n✖\s|\bAssertionError\b.*\bat TestContext\b/is.test(output)) {
    return { outcome: 'killed', detail: 'the test suite reported a failing test' };
  }
  return { outcome: 'invalid', detail: 'test runner exited without reporting a failing test' };
}

async function main() {
  if (process.argv.includes('--list')) {
    for (const m of MUTATIONS) console.log(`${m.id.padEnd(24)} ${m.defect}`);
    return;
  }

  const onlyIndex = process.argv.indexOf('--only');
  let selected = MUTATIONS;
  if (onlyIndex !== -1) {
    const ids = new Set(String(process.argv[onlyIndex + 1] ?? '').split(',').filter(Boolean));
    selected = MUTATIONS.filter((mutation) => ids.has(mutation.id));
    const missing = [...ids].filter((id) => !selected.some((mutation) => mutation.id === id));
    if (!ids.size || missing.length) {
      throw new Error(`--only requires known comma-separated mutation ids${missing.length ? ` (unknown: ${missing.join(', ')})` : ''}`);
    }
  }

  console.log(`holt mutation testing — ${selected.length} deliberate defects\n`);
  console.log('Each one must make the tests GO RED. A survivor is a hole in the suite.\n');

  const before = await repoFingerprint();
  if (!before) console.log('  (tripwire unavailable: not running from a git checkout)\n');

  const work = await makeWorkCopy();
  const results = [];
  try {
    for (const m of selected) {
      process.stdout.write(`  ${m.id.padEnd(24)} `);

      const applied = await applyMutation(work, m);
      if (!applied.ok) {
        console.log(`SKIP  (${applied.error})`);
        results.push({ ...m, outcome: 'skipped', detail: applied.error });
        continue;
      }

      try {
        const r = await run(process.execPath, ['--test', ...m.tests], work);
        const classified = classifyMutationResult(r);
        const label = classified.outcome === 'killed'
          ? 'killed  (tests caught it)'
          : classified.outcome === 'survived'
            ? 'SURVIVED  ← HOLE IN THE SUITE'
            : 'INVALID  (runner did not execute a failing test)';
        console.log(label);
        results.push({ ...m, ...classified });
      } finally {
        await fs.writeFile(path.join(work, m.file), applied.original, 'utf8');
      }

      // The tripwire: after EVERY mutation, the real repo must be byte-identical to how this
      // run found it. If it is not, isolation is broken and nothing else this harness prints
      // can be trusted — name the mutation and stop the world.
      if (before) {
        const now = await repoFingerprint();
        if (now !== before) {
          console.error(`\n  ✖ TRIPWIRE: the LIVE repository changed during mutation '${m.id}'.`);
          console.error('    A mutated holt reached outside its scratch copy. Fix that before anything else;');
          console.error('    every result above is suspect and uncommitted work may have been altered.');
          process.exitCode = 2;
          return;
        }
      }
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }

  const killed = results.filter((r) => r.outcome === 'killed').length;
  const survived = results.filter((r) => r.outcome === 'survived');
  const skipped = results.filter((r) => r.outcome === 'skipped');
  const invalid = results.filter((r) => r.outcome === 'invalid');
  const scored = killed + survived.length;

  console.log(`\n  ${killed}/${scored} mutations killed`
    + (scored ? ` (${Math.round((killed / scored) * 100)}%)` : '')
    + (skipped.length ? `  ·  ${skipped.length} skipped (anchor drifted)` : '')
    + (invalid.length ? `  ·  ${invalid.length} invalid (runner did not execute a failing test)` : ''));

  if (skipped.length) {
    console.log('\n  SKIPPED mutations prove NOTHING — their anchors no longer match the source:');
    for (const s of skipped) console.log(`    ${s.id}: ${s.detail}`);
  }

  if (invalid.length) {
    console.log('\n  INVALID MUTATIONS — the runner did not execute a failing test:');
    for (const item of invalid) console.log(`    ${item.id}: ${item.detail}`);
    process.exitCode = 1;
    return;
  }

  if (survived.length) {
    console.log('\n  SURVIVORS — the code could ship broken this way and every test would pass:');
    for (const s of survived) console.log(`    ${s.id}: ${s.defect}`);
    process.exitCode = 1;
    return;
  }
  if (skipped.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
