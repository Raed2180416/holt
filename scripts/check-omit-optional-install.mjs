#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Prove an `npm install --omit=optional --prefix ...` really omitted Holt's optional package
 * roots before the installed-artifact smoke runs.
 *
 * This is deliberately a filesystem and module-resolution check. A successful install command is
 * not evidence that npm honoured `--omit=optional`; npm 10 global installs have been observed to
 * retain the optional tree while still exiting zero. The prefix must be outside the checkout, the
 * installed Holt package must be a real directory (not a link back to source), every optional
 * dependency must be both physically absent and unresolvable from the installed package, and every
 * required direct dependency must be physically present at its exact declared version. Otherwise
 * an omit-optional smoke can go green while an advertised runtime surface is missing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

const within = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

const modulePath = (base, name) => path.join(base, ...name.split('/'));

/**
 * @param {string} prefix
 * @param {{root?: string}} [options]
 */
export async function inspectOmittedInstall(prefix, { root = ROOT } = {}) {
  const problems = [];
  const absolutePrefix = path.resolve(prefix);
  const canonicalRoot = await fs.realpath(root);
  let canonicalPrefix = null;
  try {
    canonicalPrefix = await fs.realpath(absolutePrefix);
  } catch (error) {
    problems.push(`install prefix does not exist: ${absolutePrefix} (${error.code ?? error.message})`);
    return {
      ok: false, prefix: absolutePrefix, requiredDependencies: [], presentRequired: [],
      optionalDependencies: [], absent: [], problems,
    };
  }
  if (within(canonicalRoot, canonicalPrefix)) {
    problems.push(`install prefix resolves inside the source checkout: ${canonicalPrefix}`);
  }

  const sourcePackage = JSON.parse(await fs.readFile(path.join(canonicalRoot, 'package.json'), 'utf8'));
  const requiredDependencies = Object.entries(sourcePackage.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const optionalDependencies = Object.keys(sourcePackage.optionalDependencies ?? {}).sort();
  if (requiredDependencies.length === 0) {
    problems.push('package.json declares zero required dependencies; the required-surface proof would be vacuous');
  }
  if (optionalDependencies.length === 0) {
    problems.push('package.json declares zero optional dependencies; the omission proof would be vacuous');
  }

  const nodeModules = path.join(canonicalPrefix, 'node_modules');
  const installedRoot = modulePath(nodeModules, sourcePackage.name);
  let installedPackage = null;
  try {
    const stat = await fs.lstat(installedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      problems.push(`installed Holt root is not an independent directory: ${installedRoot}`);
    }
    installedPackage = JSON.parse(await fs.readFile(path.join(installedRoot, 'package.json'), 'utf8'));
    if (installedPackage.name !== sourcePackage.name || installedPackage.version !== sourcePackage.version) {
      problems.push(
        `installed package identity is ${installedPackage.name ?? '<missing>'}@${installedPackage.version ?? '<missing>'}; `
        + `expected ${sourcePackage.name}@${sourcePackage.version}`,
      );
    }
  } catch (error) {
    problems.push(`installed Holt package is missing or unreadable: ${error.code ?? error.message}`);
  }

  const absent = [];
  const presentRequired = [];
  if (installedPackage) {
    const requireFromInstall = createRequire(path.join(installedRoot, 'package.json'));
    for (const [name, expectedVersion] of requiredDependencies) {
      const physicalRoots = [
        modulePath(nodeModules, name),
        modulePath(path.join(installedRoot, 'node_modules'), name),
      ];
      const roots = [];
      for (const candidate of physicalRoots) {
        const stat = await fs.lstat(candidate).catch(() => null);
        if (stat?.isDirectory() && !stat.isSymbolicLink()) roots.push(candidate);
      }
      if (roots.length !== 1) {
        problems.push(`${name} required at ${expectedVersion} has ${roots.length} independent package root(s); expected exactly one`);
        continue;
      }
      try {
        const dependencyPackage = JSON.parse(await fs.readFile(path.join(roots[0], 'package.json'), 'utf8'));
        if (dependencyPackage.name !== name || dependencyPackage.version !== expectedVersion) {
          problems.push(
            `${name} required at ${expectedVersion} is ${dependencyPackage.name ?? '<missing>'}@${dependencyPackage.version ?? '<missing>'}`,
          );
          continue;
        }
        presentRequired.push(name);
      } catch (error) {
        problems.push(`${name} required at ${expectedVersion} is unreadable: ${error.code ?? error.message}`);
      }
    }
    for (const name of optionalDependencies) {
      const physicalRoots = [
        modulePath(nodeModules, name),
        modulePath(path.join(installedRoot, 'node_modules'), name),
      ];
      const present = [];
      for (const candidate of physicalRoots) {
        if (await fs.lstat(candidate).then(() => true, () => false)) present.push(candidate);
      }
      let resolved = null;
      try { resolved = requireFromInstall.resolve(name); } catch { /* expected: omitted */ }
      if (present.length || resolved) {
        problems.push(`${name} was not omitted${present.length ? `; present at ${present.join(', ')}` : ''}${resolved ? `; resolves to ${resolved}` : ''}`);
      } else {
        absent.push(name);
      }
    }
  }

  return {
    ok: problems.length === 0,
    prefix: canonicalPrefix,
    package: installedPackage ? `${installedPackage.name}@${installedPackage.version}` : null,
    requiredDependencies: requiredDependencies.map(([name]) => name),
    presentRequired,
    optionalDependencies,
    absent,
    problems,
  };
}

function parsePrefix(argv) {
  const index = argv.indexOf('--prefix');
  if (index === -1 || !argv[index + 1]) throw new Error('usage: node scripts/check-omit-optional-install.mjs --prefix <outside-checkout-prefix>');
  if (argv.length !== 2 || index !== 0) throw new Error(`unexpected arguments: ${argv.join(' ')}`);
  return argv[index + 1];
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  try {
    const result = await inspectOmittedInstall(parsePrefix(process.argv.slice(2)));
    if (!result.ok) {
      for (const problem of result.problems) console.error(`omit-optional proof failed: ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(
        `omit-optional proof: ${result.absent.length}/${result.optionalDependencies.length} optional roots absent; `
        + `${result.presentRequired.length}/${result.requiredDependencies.length} required roots exact in ${result.package}`,
      );
    }
  } catch (error) {
    console.error(`omit-optional proof failed: ${error.message}`);
    process.exitCode = 2;
  }
}
