const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createEmptyDatabase } = require('./helpers/database.js');
const { fakeProviderChain } = require('./helpers/providerChain.js');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';

const A1 = '0xa100000000000000000000000000000000000001';
const A2 = '0xa200000000000000000000000000000000000002';
const A3 = '0xa300000000000000000000000000000000000003';

test('provider attester index', { skip }, async (t) => {
  const pool = new Pool({ connectionString: await createEmptyDatabase(url, 'bot_provider_index') });
  t.after(() => pool.end());
  await require('../db/migrate.js').migrate(pool);
  const { syncProviderAttesters, isProviderActive } = require('../providers/attesterIndex.js');
  t.beforeEach(() => pool.query('TRUNCATE provider_attesters, event_cursors'));
  const attestersOf = async (id) =>
    (await pool.query('SELECT attester FROM provider_attesters WHERE provider_id = $1 ORDER BY attester', [id])).rows.map((r) => r.attester);

  await t.test('the sync stores each staked attester from the start block', async () => {
    const chain = fakeProviderChain({ startBlock: 100 });
    chain.stake(5, A1, 120);
    chain.stake(5, A2, 9000);
    chain.stake(7, A3, 9500);
    chain.stake(9, A3, 50); // before the start block, so not read

    await syncProviderAttesters(pool, 'mainnet', chain);

    assert.deepEqual(await attestersOf(5), [A1, A2]);
    assert.deepEqual(await attestersOf(7), [A3]);
    assert.deepEqual(await attestersOf(9), []);
  });

  await t.test('a second sync reads only the new blocks and stores no duplicate', async () => {
    const chain = fakeProviderChain({ startBlock: 100 });
    chain.stake(5, A1, 120);
    await syncProviderAttesters(pool, 'mainnet', chain);
    const before = chain.state.logQueries;

    chain.stake(5, A1, 130);
    chain.stake(5, A2, 140);
    await syncProviderAttesters(pool, 'mainnet', chain);

    assert.equal(chain.state.logQueries - before, 1);
    assert.deepEqual(await attestersOf(5), [A1, A2]);
  });

  await t.test('a range that the RPC refuses is split until it is accepted', async () => {
    const chain = fakeProviderChain({ startBlock: 100 });
    chain.stake(5, A1, 3000);
    chain.state.maxRange = 1000;

    await syncProviderAttesters(pool, 'mainnet', chain);

    assert.deepEqual(await attestersOf(5), [A1]);
  });

  await t.test('a failed sync keeps the stored part, and the next sync continues from there', async () => {
    const chain = fakeProviderChain({ startBlock: 100 });
    chain.stake(5, A1, 200);
    chain.stake(5, A2, 9000);
    chain.state.maxRange = 3900;
    await syncProviderAttesters(pool, 'mainnet', fakeProviderChainWithLatest(chain, 4000));
    assert.deepEqual(await attestersOf(5), [A1]);

    chain.state.failNext = 100; // every query fails
    await assert.rejects(syncProviderAttesters(pool, 'mainnet', chain), /rpc unavailable/);
    chain.state.failNext = 0;

    await syncProviderAttesters(pool, 'mainnet', chain);
    assert.deepEqual(await attestersOf(5), [A1, A2]);
  });

  await t.test('a provider with one validating attester is active', async () => {
    const chain = fakeProviderChain({ startBlock: 100 });
    chain.stake(5, A1, 120);
    chain.stake(5, A2, 130);
    chain.setValidating(A2);
    await syncProviderAttesters(pool, 'mainnet', chain);
    assert.equal(await isProviderActive(pool, 'mainnet', 5, chain), true);
  });

  await t.test('a provider with no validating attester is not active', async () => {
    const chain = fakeProviderChain({ startBlock: 100 });
    chain.stake(5, A1, 120);
    await syncProviderAttesters(pool, 'mainnet', chain);
    assert.equal(await isProviderActive(pool, 'mainnet', 5, chain), false);
  });

  await t.test('the index of one network does not count for the other', async () => {
    const chain = fakeProviderChain({ startBlock: 100 });
    chain.stake(5, A1, 120);
    chain.setValidating(A1);
    await syncProviderAttesters(pool, 'mainnet', chain);
    assert.equal(await isProviderActive(pool, 'testnet', 5, chain), false);
  });

  await t.test('the index of one StakingRegistry does not count for a different registry', async () => {
    const registryA = fakeProviderChain({ startBlock: 100, registryAddress: '0x00000000000000000000000000000000000000AA' });
    registryA.stake(5, A1, 120);
    await syncProviderAttesters(pool, 'mainnet', registryA);
    const { rows } = await pool.query('SELECT registry FROM provider_attesters');
    assert.deepEqual(rows, [{ registry: '0x00000000000000000000000000000000000000aa' }]);

    const registryB = fakeProviderChain({ startBlock: 100, registryAddress: '0x00000000000000000000000000000000000000BB' });
    registryB.setValidating(A1);
    await syncProviderAttesters(pool, 'mainnet', registryB);
    assert.equal(await isProviderActive(pool, 'mainnet', 5, registryB), false);
  });
});

// The same fake, but with a lower latest block, for a partial first sync.
function fakeProviderChainWithLatest(chain, latest) {
  return { ...chain, latestBlock: async () => latest };
}
