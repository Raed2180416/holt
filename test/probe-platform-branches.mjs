// Proves the win32 branch of the never-worse test asserts what the PRODUCT actually does, without
// waiting a CI cycle. process.platform is read at call time inside the tokeniser, so faking it
// before the call exercises the real Windows path on this machine.
import assert from 'node:assert/strict';

const load = async (platform) => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  // fresh module instance so nothing platform-dependent is cached from a previous load
  const m = await import(`/home/raed/grove/src/agent.mjs?p=${platform}-${Math.random()}`);
  return { m, restore: () => Object.defineProperty(process, 'platform', real) };
};

const first = (m, cmd) => (m.resolveFileTargets(cmd)[0] ?? {}).raw;

{
  const { m, restore } = await load('win32');
  assert.equal(first(m, 'rm a\\$b.txt'), 'a\\$b.txt',
    'WIN32: a backslash is a separator — the path must survive whole');
  assert.equal(first(m, 'rm foo\\ bar.txt'), 'foo bar.txt',
    'WIN32: an escaped space is still a quoted space, in both worlds');
  restore();
  console.log('win32 branch  OK — matches what the test now asserts on windows-latest');
}
{
  const { m, restore } = await load('linux');
  assert.equal(first(m, 'rm a\\$b.txt'), 'a$b.txt', 'POSIX: escaped dollar is a literal dollar');
  assert.equal(first(m, 'rm foo\\ bar.txt'), 'foo bar.txt', 'POSIX: escaped space is part of the name');
  restore();
  console.log('posix branch  OK');
}

// ANTI-VACUITY. If the two branches expected the SAME string, the platform split would be
// decoration and the test could not have failed on CI in the first place.
assert.notEqual('a\\$b.txt', 'a$b.txt', 'the two platform expectations must actually differ');
console.log('branches genuinely differ — the split is load-bearing, not decoration');
