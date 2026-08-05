import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ROOT = new URL('../../', import.meta.url);

test('official MCP Registry metadata stays bound to the public package and MCP entrypoint', async () => {
  const [pkg, server] = await Promise.all([
    fs.readFile(new URL('package.json', ROOT), 'utf8').then(JSON.parse),
    fs.readFile(new URL('server.json', ROOT), 'utf8').then(JSON.parse),
  ]);

  assert.equal(server.$schema,
    'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  assert.equal(server.name, pkg.mcpName, 'registry name must equal npm ownership marker');
  assert.equal(server.version, pkg.version, 'server metadata must name the exact package version');
  assert.ok(server.description.length <= 100, 'registry rejects descriptions over 100 characters');
  assert.deepEqual(server.repository, {
    url: 'https://github.com/Raed2180416/holt',
    source: 'github',
  });

  assert.equal(server.packages.length, 1, 'one exact install path avoids ambiguous runtime choice');
  const [entry] = server.packages;
  assert.equal(entry.registryType, 'npm');
  assert.equal(entry.identifier, pkg.name);
  assert.equal(entry.version, pkg.version);
  assert.deepEqual(entry.transport, { type: 'stdio' });
  assert.deepEqual(entry.packageArguments, [{ type: 'positional', value: 'mcp' }],
    'registry clients must launch `holt mcp`, not the human CLI default');
  assert.ok(pkg.files.includes('server.json'), 'published package must retain its registry metadata');
});
