// SPDX-License-Identifier: FSL-1.1-MIT
/** Bounded lexical capability inventory for the shipped optional native process supervisor.
 * This is an inventory, not a sandbox: ctypes is explicitly native authority, including the
 * ability to call arbitrary OS functions. Unknown imports or dynamic evaluation are findings.
 */
const MODULES = {
  ctypes: ['native'], subprocess: ['process'], os: ['filesystem', 'process'], signal: ['process'],
  pathlib: ['filesystem'], io: ['filesystem'], shutil: ['filesystem', 'process'],
  socket: ['network'], ssl: ['network'], http: ['network'], urllib: ['network'], requests: ['network'],
  importlib: ['eval'], builtins: ['eval'], pickle: ['eval'], marshal: ['eval'],
  json: [], sys: [], time: [], errno: [], struct: [], threading: ['process'],
};

/** Mask comments and strings without letting a docstring hide a later import. */
export function pythonExecutable(source) {
  const out = source.split('');
  const blank = (i) => { if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' '; };
  let safe = true;
  let formatted = false;
  for (let i = 0; i < source.length;) {
    if (source[i] === '#') { while (i < source.length && source[i] !== '\n') blank(i++); continue; }
    if (source[i] !== '"' && source[i] !== "'") { i++; continue; }
    const quote = source[i];
    const prefix = source.slice(Math.max(0, i - 2), i);
    if (/(?:^|\W)[fr]*f[fr]*$/i.test(prefix)) formatted = true;
    const triple = source.slice(i, i + 3) === quote.repeat(3);
    const size = triple ? 3 : 1;
    for (let j = 0; j < size; j++) blank(i++);
    let closed = false;
    while (i < source.length) {
      if (source[i] === '\\') { blank(i++); if (i < source.length) blank(i++); continue; }
      if (source.slice(i, i + size) === quote.repeat(size)) {
        for (let j = 0; j < size; j++) blank(i++);
        closed = true;
        break;
      }
      if (!triple && /[\r\n]/.test(source[i])) { safe = false; break; }
      blank(i++);
    }
    if (!closed) { safe = false; break; }
  }
  return { code: out.join(''), safe, formatted };
}

export function pythonInventory(source) {
  const lexical = pythonExecutable(source);
  const caps = new Set();
  const imports = new Set();
  const aliases = new Map();
  for (const match of lexical.code.matchAll(/(?:^|[;\n])\s*(?:from\s+([\w.]+)\s+import\s+([^\n;]+)|import\s+([^\n;]+))/g)) {
    const clauses = match[1] ? [match[1]] : match[3].split(',');
    for (const clause of clauses) {
      const parsed = clause.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?/);
      if (!parsed) continue;
      const module = parsed[1].split('.')[0];
      imports.add(module);
      aliases.set(parsed[2] ?? module, module);
      for (const cap of MODULES[module] ?? ['eval']) caps.add(cap);
    }
  }
  if (/\b(?:open|input)\s*\(/.test(lexical.code)) caps.add('filesystem');
  if (/\b(?:__import__|eval|exec|compile|globals|locals)\s*\(/.test(lexical.code) || lexical.formatted) caps.add('eval');
  const targets = new Set();
  for (const [alias, module] of aliases) {
    if (module !== 'subprocess' && module !== 'os') continue;
    const expression = new RegExp(`\\b${alias}\\.(?:Popen|run|call|check_call|check_output|system|exec[a-z]*|spawn[a-z]*)\\s*\\(`, 'g');
    for (const match of lexical.code.matchAll(expression)) {
      const suffix = source.slice(match.index + match[0].length).trimStart();
      const literal = suffix.match(/^(['"])([^'"\n]+)\1/);
      const dynamic = suffix.match(/^([A-Za-z_][\w]*)/);
      targets.add(literal ? literal[2] : `<dynamic:${dynamic?.[1] ?? 'expression'}>`);
    }
  }
  // Ambient environment access is explicit even when a variable name cannot be resolved.
  const environment = new Set();
  if (/\b(?:os\.)?(?:environ|getenv)\b/.test(lexical.code)) environment.add('<computed>');
  return { ...lexical, caps, imports, targets, environment };
}
