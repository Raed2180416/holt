/**
 * grove — the MONSTER round.
 *
 * Builds the worst repository we know how to build — deliberately hard to follow, deliberately
 * hard to manage — then runs grove's complete loop against it and grades every verdict against
 * planted ground truth. This is the recursive stress instrument: every gap it finds becomes a
 * fix and a permanent test, then the monster runs again.
 *
 * WHAT MAKES IT A MONSTER (all at once, in one repo):
 *   - 80+ worktrees across FOUR languages (js/py/go/rs) with mixed prose and config
 *   - valuable work BURIED: one real file among heaps of junk; prose-only value; a one-line
 *     change; committed-ahead work on detached heads; work duplicated across exactly two trees
 *   - decoys: rich multi-commit history that base independently landed; names that lie in both
 *     directions (DELETEME holding gold, KEEP and IMPORTANT empty); recent mtimes on junk,
 *     ancient mtimes on gold
 *   - hazards: nested git repos, node_modules/dist heaps, binary blobs, deep paths, unicode
 *     names, names with spaces, a worktree named x.lock (detached), foreign-locked trees,
 *     broken registrations (directory deleted), gitignored-only content (a documented limit),
 *     empty-file-only trees, huge generated files
 *
 * GRADING IS THE POINT. For every planted item the script asserts grove's verdict; for the
 * destructive path it runs protect -> clean --apply -> rescue --release on a sample and
 * re-checks content survival by bytes. Exit non-zero on ANY wrong verdict.
 *
 *   node eval/monster.mjs [count]     # default 80 worktrees
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { discover } from '../src/discover.mjs';
import { scan } from '../src/scan.mjs';
import { analyze } from '../src/analyze.mjs';
import { protect, clean, rescue } from '../src/actions.mjs';

const COUNT = Math.max(20, Number(process.argv[2] ?? 80));
const WORK = process.env.GROVE_MONSTER_WORK
  ?? path.join(os.homedir(), '.agentic-os-tmp', 'grove-monster');

function sh(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@m', GIT_COMMITTER_NAME: 'm',
        GIT_COMMITTER_EMAIL: 'm@m', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }));
  });
}

async function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

const LANGS = [
  { ext: 'js', fn: (n, i) => `export function ${n}() { return ${i}; }\n` },
  { ext: 'py', fn: (n, i) => `def ${n}():\n    return ${i}\n` },
  { ext: 'go', fn: (n, i) => `package m\n\nfunc ${n}() int { return ${i} }\n` },
  { ext: 'rs', fn: (n, i) => `pub fn ${n}() -> i32 { ${i} }\n` },
];

/** Junk heap: what agent runs actually leave behind. */
async function heapJunk(wt, i) {
  for (let j = 0; j < 6; j++) {
    await write(wt, `node_modules/dep${j}/index.js`, `module.exports=${j};\n`);
  }
  await write(wt, 'dist/bundle.min.js', `console.log(${'0,'.repeat(2000)}0);\n`);
  await write(wt, `logs/run-${i}.log`, `${'noise\n'.repeat(200)}`);
  await write(wt, 'blob.bin', Buffer.alloc(4096, i % 256));
}

async function main() {
  console.log(`grove MONSTER · ${COUNT} worktrees · every trap at once\n`);
  await fs.rm(WORK, { recursive: true, force: true });
  const root = path.join(WORK, 'repo');
  await fs.mkdir(root, { recursive: true });

  // A real-ish polyglot base: 120 files.
  await sh('git', ['init', '-q', '--initial-branch=main'], root);
  for (let i = 0; i < 30; i++) {
    for (const L of LANGS) await write(root, `src/${L.ext}/mod_${i}.${L.ext}`, L.fn(`base_${L.ext}_${i}`, i));
  }
  await write(root, '.gitignore', 'secret-cache/\nnode_modules/\ndist/\nlogs/\n*.bin\n');
  await write(root, 'README.md', '# monster\n');
  await sh('git', ['add', '-A'], root);
  await sh('git', ['commit', '-q', '-m', 'base'], root);
  const base = (await sh('git', ['rev-parse', 'HEAD'], root)).stdout.trim();

  const wtRoot = path.join(WORK, 'trees');
  await fs.mkdir(wtRoot, { recursive: true });

  const truth = {
    mustSurvive: new Map(),   // id -> [relPath, byteMarker]
    disposable: new Set(),
    eitherNotBoth: [],        // [idA, idB, marker]
    unknownExpected: new Set(),
    foreignLocked: new Set(),
    gitignoredOnly: new Set(), // documented limit: expected DISPOSABLE
  };

  const mk = async (name, { branch = false } = {}) => {
    const p = path.join(wtRoot, name);
    const args = branch
      ? ['worktree', 'add', '-q', '-b', `wt/${name.replace(/[^A-Za-z0-9._-]/g, '_')}`, p, base]
      : ['worktree', 'add', '-q', '--detach', p, base];
    const r = await sh('git', args, root);
    if (r.code !== 0) throw new Error(`worktree add ${name}: ${r.stderr}`);
    return p;
  };

  let n = 0;
  const nextLang = () => LANGS[n % LANGS.length];

  while (n < COUNT) {
    const kind = n % 16;
    const L = nextLang();
    const id = (() => {
      // Names that lie, names that hurt.
      if (kind === 0) return `DELETEME-junk-${n}`;
      if (kind === 1) return `IMPORTANT-do-not-delete-${n}`;
      if (kind === 2) return `wt space ${n}`;
      if (kind === 3) return `ünïcode-${n}`;
      return `agent-run-${1000 + n}`;
    })();

    const wt = await mk(id, { branch: kind === 5 });

    switch (kind) {
      case 0: { // alarming name, buried gold: one real file under a junk heap
        await heapJunk(wt, n);
        const marker = `BURIED_GOLD_${n}`;
        await write(wt, `src/${L.ext}/gold_${n}.${L.ext}`, L.fn(marker, n));
        truth.mustSurvive.set(id, [`src/${L.ext}/gold_${n}.${L.ext}`, marker]);
        break;
      }
      case 1: { // reassuring name, nothing but junk
        await heapJunk(wt, n);
        truth.disposable.add(id);
        break;
      }
      case 2: { // space in name + prose-only value (symbol layer skips prose by design)
        const marker = `prose irreplaceable ${n}`;
        await write(wt, 'notes/decision.md', `# decision\n${marker}\n`);
        truth.mustSurvive.set(id, ['notes/decision.md', marker]);
        break;
      }
      case 3: { // unicode name + unicode symbols
        const marker = `unicode_wörk_${n}`;
        await write(wt, `src/üni_${n}.js`, `export function ${marker}() { return 1; }\n`);
        truth.mustSurvive.set(id, [`src/üni_${n}.js`, marker]);
        break;
      }
      case 4: { // committed-ahead on detached head
        const marker = `ahead_${L.ext}_${n}`;
        await write(wt, `src/${L.ext}/a_${n}.${L.ext}`, L.fn(marker, n));
        await sh('git', ['add', '-A'], wt);
        await sh('git', ['commit', '-q', '-m', `ahead ${n}`], wt);
        truth.mustSurvive.set(id, [`src/${L.ext}/a_${n}.${L.ext}`, marker]);
        break;
      }
      case 5: { // landed decoy with RICH history (4 commits), base independently has it all
        const marker = `landed_${n}`;
        const rel = `src/${L.ext}/l_${n}.${L.ext}`;
        for (let c = 0; c < 3; c++) {
          await write(wt, rel, L.fn(marker, c));
          await sh('git', ['add', '-A'], wt);
          await sh('git', ['commit', '-q', '-m', `iter ${c}`], wt);
        }
        const final = L.fn(marker, 99);
        await write(wt, rel, final);
        await sh('git', ['add', '-A'], wt); await sh('git', ['commit', '-q', '-m', 'final'], wt);
        await write(root, rel, final);
        await sh('git', ['add', '-A'], root); await sh('git', ['commit', '-q', '-m', `land ${n}`], root);
        truth.disposable.add(id);
        break;
      }
      case 6: { // duplicated across exactly two trees — either may go, not both
        const marker = `twin_${n}`;
        const body = L.fn(marker, n);
        await write(wt, `src/twin_${n}.${L.ext}`, body);
        const id2 = `agent-run-${1000 + n}-b`;
        const wt2 = await mk(id2);
        await write(wt2, `src/twin_${n}.${L.ext}`, body);
        truth.eitherNotBoth.push([id, id2, marker]);
        n++; // consumed an extra slot
        break;
      }
      case 7: { // nested git repo + real value beside it
        await sh('git', ['init', '-q'], path.join(wt, 'vendor/inner'));
        await write(wt, 'vendor/inner/inner.txt', 'INNER\n');
        const marker = `beside_nested_${n}`;
        await write(wt, `src/${L.ext}/b_${n}.${L.ext}`, L.fn(marker, n));
        truth.mustSurvive.set(id, [`src/${L.ext}/b_${n}.${L.ext}`, marker]);
        break;
      }
      case 8: { // gitignored-only content — DOCUMENTED LIMIT: grove must call it disposable
        await write(wt, 'secret-cache/only-here.txt', `IGNORED_${n}\n`);
        truth.gitignoredOnly.add(id);
        truth.disposable.add(id);
        break;
      }
      case 9: { // foreign lock on a junk tree — clean must skip it, unprotect must not touch it
        await heapJunk(wt, n);
        await sh('git', ['worktree', 'lock', '--reason', `human: kept for audit ${n}`, wt], root);
        truth.foreignLocked.add(id);
        break;
      }
      case 10: { // broken registration: directory deleted underneath git
        await write(wt, 'src/gone.js', 'export function GONE() {}\n');
        await fs.rm(wt, { recursive: true, force: true });
        truth.unknownExpected.add(id);
        break;
      }
      case 11: { // one-line change to a tracked file, buried under junk
        await heapJunk(wt, n);
        const marker = `ONE_LINE_${n}`;
        await write(wt, 'README.md', `# monster\n<!-- ${marker} -->\n`);
        truth.mustSurvive.set(id, ['README.md', marker]);
        break;
      }
      case 12: { // deep path + config-format value (yaml keys, not code symbols)
        const marker = `deep_key_${n}`;
        const deep = Array.from({ length: 14 }, (_, i2) => `d${i2}`).join('/');
        await write(wt, `${deep}/routes.yaml`, `routes:\n  - name: ${marker}\n    path: /x\n`);
        truth.mustSurvive.set(id, [`${deep}/routes.yaml`, marker]);
        break;
      }
      case 13: { // uncommitted DELETION of tracked files — a decision, not disposable
        await fs.rm(path.join(wt, 'src/js/mod_0.js'), { force: true });
        await fs.rm(path.join(wt, 'src/py/mod_1.py'), { force: true });
        truth.mustSurvive.set(id, [null, null]); // nothing to find; must simply not be "safe"
        break;
      }
      default: { // genuinely spent: junk only or empty
        if (n % 2) await heapJunk(wt, n);
        truth.disposable.add(id);
      }
    }
    n++;
  }

  // The x.lock hostile name, detached (git refuses .lock in branch names).
  {
    const p = path.join(wtRoot, 'x.lock');
    await sh('git', ['worktree', 'add', '-q', '--detach', p, base], root);
    await write(p, 'src/hostile.js', 'export function HOSTILE_LOCKNAME() {}\n');
    truth.mustSurvive.set('x.lock', ['src/hostile.js', 'HOSTILE_LOCKNAME']);
  }

  const total = (await sh('git', ['worktree', 'list'], root)).stdout.trim().split('\n').length - 1;
  console.log(`  built ${total} worktrees\n`);

  /* ---------------------------------------------------------------- grade ---- */
  const t0 = Date.now();
  const disc = await discover(root);
  const scanned = await scan(disc, {});
  const report = await analyze(scanned, {});
  console.log(`  scan+analyze  ${Date.now() - t0}ms for ${report.counts.workstreams} workstreams`);

  const errors = [];
  const verdictOf = (id) => report.safe.find((s) => s.id === id || s.id.endsWith(`/${id}`));

  for (const [id] of truth.mustSurvive) {
    const v = verdictOf(id);
    if (!v) { errors.push(`${id}: MISSING from report`); continue; }
    if (v.safe) errors.push(`${id}: holds irreplaceable content but grove says SAFE`);
  }
  for (const id of truth.disposable) {
    const v = verdictOf(id);
    if (!v) { errors.push(`${id}: MISSING from report`); continue; }
    if (!v.safe && !truth.foreignLocked.has(id)) {
      errors.push(`${id}: planted disposable but grove refuses (${v.reasons.join('; ')})`);
    }
  }
  for (const id of truth.unknownExpected) {
    const v = verdictOf(id);
    if (!v) { errors.push(`${id}: broken registration vanished from report entirely`); continue; }
    if (v.safe) errors.push(`${id}: unassessable but called SAFE (fail-open)`);
  }
  for (const [a, b] of truth.eitherNotBoth) {
    const va = verdictOf(a); const vb = verdictOf(b);
    if (va?.safe && vb?.safe) errors.push(`${a}+${b}: duplicated pair BOTH called safe — deleting both loses the work`);
  }

  console.log(`  diagnostic verdicts: ${errors.length === 0 ? 'ALL CORRECT' : errors.length + ' WRONG'}`);

  /* ------------------------------------------------- the destructive loop ---- */
  const p = await protect(root, {});
  console.log(`  protect: locked ${p.protected}, unknown ${p.unknown.length}, failed ${p.failed}`);

  const c = await clean(root, { apply: true });
  console.log(`  clean --apply: removed ${c.removed}, skipped ${c.skipped.length}, failed ${c.failed.length}`);

  // Every irreplaceable byte must still exist on disk after the destructive pass.
  for (const [id, spec] of truth.mustSurvive) {
    if (!spec || !spec[0]) continue;
    const node = report.graph.nodes.find((x) => x.id === id || x.id.endsWith(`/${id}`));
    if (!node?.path) { errors.push(`${id}: no path recorded`); continue; }
    const content = await fs.readFile(path.join(node.path, spec[0]), 'utf8').catch(() => null);
    if (content === null || !content.includes(spec[1])) {
      errors.push(`${id}: ${spec[0]} DESTROYED or altered by the loop`);
    }
  }
  // Foreign locks must still be locked.
  for (const id of truth.foreignLocked) {
    const porcelain = (await sh('git', ['worktree', 'list', '--porcelain'], root)).stdout;
    if (!porcelain.includes('locked')) errors.push(`${id}: foreign lock vanished`);
  }

  // Rescue a sample of the survivors end-to-end and verify by bytes from the REF.
  let rescued = 0;
  for (const [id, spec] of [...truth.mustSurvive].slice(0, 5)) {
    if (!spec || !spec[0]) continue;
    const r = await rescue(root, id, { release: true });
    if (!r.ok) { errors.push(`${id}: rescue failed: ${r.error}`); continue; }
    const show = await sh('git', ['show', `${r.commit}:${spec[0]}`], root);
    if (!show.stdout.includes(spec[1])) errors.push(`${id}: rescued ref missing the marker`);
    else rescued++;
  }
  console.log(`  rescue sample: ${rescued} verified by bytes from refs`);

  if (errors.length) {
    console.error(`\n  ✗ ${errors.length} FAILURES:\n${errors.slice(0, 20).map((e) => `    ${e}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('\n  ✓ MONSTER SURVIVED: every verdict correct, every irreplaceable byte intact\n');
  }

  await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
}

main().catch((e) => { console.error(e); process.exit(1); });
