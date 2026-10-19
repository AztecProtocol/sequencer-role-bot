const test = require('node:test');
const assert = require('node:assert/strict');
const { createRollupResolver } = require('../rollupResolver.js');

const V5 = '0x91fF8bbD8Ebb07893010D50A48A1609e5EBd8E34';
const V6 = '0x00000000000000000000000000000000000000B6';
const TEN_MINUTES = 10 * 60 * 1000;

// A stand-in for Registry.getCanonicalRollup() that counts its reads.
function registry(initial) {
  const state = { address: initial, reads: 0, down: false };
  state.read = async () => {
    state.reads += 1;
    if (state.down) throw new Error('rpc unavailable');
    return state.address;
  };
  return state;
}

function setup(t) {
  t.mock.timers.enable({ apis: ['Date'], now: 1791193440000 });
  const warnings = [];
  const resolve = createRollupResolver({ warn: (message) => warnings.push(message) });
  return { resolve, warnings };
}

test('the canonical rollup from the registry is used', async (t) => {
  const { resolve } = setup(t);
  const reg = registry(V5);
  assert.equal(await resolve('mainnet', { readCanonical: reg.read }), V5);
});

test('the registry is not read again for ten minutes', async (t) => {
  const { resolve } = setup(t);
  const reg = registry(V5);
  await resolve('mainnet', { readCanonical: reg.read });
  t.mock.timers.tick(TEN_MINUTES - 1);
  await resolve('mainnet', { readCanonical: reg.read });
  assert.equal(reg.reads, 1);
});

test('a rollup upgrade is picked up within ten minutes and reported', async (t) => {
  const { resolve, warnings } = setup(t);
  const reg = registry(V5);
  await resolve('mainnet', { readCanonical: reg.read });

  reg.address = V6;
  t.mock.timers.tick(TEN_MINUTES);

  assert.equal(await resolve('mainnet', { readCanonical: reg.read }), V6);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(V5) && warnings[0].includes(V6));
});

test('the last known rollup is kept when the registry cannot be read', async (t) => {
  const { resolve } = setup(t);
  const reg = registry(V5);
  await resolve('mainnet', { readCanonical: reg.read });

  reg.down = true;
  t.mock.timers.tick(TEN_MINUTES);

  assert.equal(await resolve('mainnet', { readCanonical: reg.read }), V5);
});

test('resolution fails when the registry cannot be read and no rollup is known', async (t) => {
  const { resolve } = setup(t);
  const reg = registry(V5);
  reg.down = true;
  await assert.rejects(resolve('mainnet', { readCanonical: reg.read }), /rpc unavailable/);
});

test('each network keeps its own rollup', async (t) => {
  const { resolve } = setup(t);
  const mainnet = registry(V5);
  const testnet = registry(V6);
  await resolve('mainnet', { readCanonical: mainnet.read });
  assert.equal(await resolve('testnet', { readCanonical: testnet.read }), V6);
});

test('a configured rollup address is used in place of the registry', async (t) => {
  const { resolve, warnings } = setup(t);
  assert.equal(await resolve('mainnet', { override: V5 }), V5);
  assert.equal(warnings.length, 0);
});

test('a configured rollup address that is not the canonical rollup is reported', async (t) => {
  const { resolve, warnings } = setup(t);
  const reg = registry(V6);
  const address = await resolve('mainnet', { override: V5, readCanonical: reg.read });
  assert.equal(address, V5);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(V5) && warnings[0].includes(V6));
});

test('a configured rollup address that equals the canonical rollup in a different letter case is not reported', async (t) => {
  const { resolve, warnings } = setup(t);
  const reg = registry(V5.toLowerCase());
  await resolve('mainnet', { override: V5, readCanonical: reg.read });
  assert.equal(warnings.length, 0);
});

test('resolution fails when no registry and no rollup address are configured', async (t) => {
  const { resolve } = setup(t);
  await assert.rejects(resolve('mainnet', {}), /registry/i);
});

test('a subscriber hears each canonical change once, with the old and the new address', async (t) => {
  const { resolve } = setup(t);
  const changes = [];
  resolve.onCanonicalChange((network, from, to) => changes.push([network, from, to]));
  const reg = registry(V5);
  await resolve('mainnet', { readCanonical: reg.read });

  reg.address = V6;
  t.mock.timers.tick(TEN_MINUTES);
  await resolve('mainnet', { readCanonical: reg.read });
  t.mock.timers.tick(TEN_MINUTES);
  await resolve('mainnet', { readCanonical: reg.read });

  assert.deepEqual(changes, [['mainnet', V5, V6]]);
});

test('a subscriber that fails does not stop the resolver', async (t) => {
  const { resolve } = setup(t);
  resolve.onCanonicalChange(() => { throw new Error('subscriber failed'); });
  resolve.onCanonicalChange(async () => { throw new Error('async subscriber failed'); });
  const reg = registry(V5);
  await resolve('mainnet', { readCanonical: reg.read });
  reg.address = V6;
  t.mock.timers.tick(TEN_MINUTES);
  assert.equal(await resolve('mainnet', { readCanonical: reg.read }), V6);
});

test('the module has a subscription for the shared resolver', () => {
  const resolver = require('../rollupResolver.js');
  assert.equal(typeof resolver.onCanonicalChange, 'function');
});
