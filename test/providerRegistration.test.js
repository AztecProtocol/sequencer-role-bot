const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { Pool } = require('pg');
const { createEmptyDatabase } = require('./helpers/database.js');
const { fakeProviderChain } = require('./helpers/providerChain.js');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';
const USER = '900000000000000001';
const OTHER_USER = '900000000000000002';
const ATTESTER = '0xa100000000000000000000000000000000000001';

test('provider registration logic', { skip }, async (t) => {
  const pool = new Pool({ connectionString: await createEmptyDatabase(url, 'bot_provider_registration') });
  t.after(() => pool.end());
  await require('../db/migrate.js').migrate(pool);

  const chainModule = require('../providers/chain.js');
  const chains = new Map();
  chainModule.forNetwork = (network) => chains.get(String(network).toLowerCase()) || null;
  const { startProviderRegistration, completeProviderRegistration } = require('../providers/registration.js');

  let admin;
  let chain;
  t.beforeEach(async () => {
    await pool.query('TRUNCATE provider_registrations, provider_attesters, event_cursors RESTART IDENTITY');
    admin = ethers.Wallet.createRandom();
    chain = fakeProviderChain({ startBlock: 100 });
    chain.setProvider(5, admin.address, '0x2222222222222222222222222222222222222222');
    chain.stake(5, ATTESTER, 150);
    chain.setValidating(ATTESTER);
    chains.clear();
    chains.set('mainnet', chain);
  });

  const start = (overrides = {}) => startProviderRegistration(pool, {
    discordUserId: USER, discordUsername: 'operator', network: 'mainnet', providerId: '5', signer: admin.address, ...overrides
  });
  const complete = async (started, signer = admin, user = USER) => completeProviderRegistration(pool, {
    recordId: started.recordId, discordUserId: user, signature: await signer.signMessage(started.message)
  });

  await t.test('an admin that signs completes the registration for its network', async () => {
    const started = await start();
    assert.equal(started.ok, true);
    assert.deepEqual(await complete(started), { ok: true, network: 'mainnet', providerId: 5 });
    const { rows } = await pool.query('SELECT status, signer_kind FROM provider_registrations');
    assert.deepEqual(rows, [{ status: 'completed', signer_kind: 'admin' }]);
  });

  await t.test('a network without a StakingRegistry refuses', async () => {
    assert.deepEqual(await start({ network: 'testnet' }), { ok: false, reason: 'not_configured' });
  });

  await t.test('a provider id that is not a number, or a signer that is not an address, is refused', async () => {
    assert.deepEqual(await start({ providerId: 'five' }), { ok: false, reason: 'invalid_input' });
    assert.deepEqual(await start({ signer: 'not-an-address' }), { ok: false, reason: 'invalid_input' });
  });

  await t.test('a provider id that is not in use is refused', async () => {
    assert.deepEqual(await start({ providerId: '99' }), { ok: false, reason: 'no_provider' });
  });

  await t.test('an address with no role in the provider is refused', async () => {
    assert.deepEqual(await start({ signer: ethers.Wallet.createRandom().address }), { ok: false, reason: 'not_eligible' });
  });

  await t.test('a registration in use is not replaced', async () => {
    await complete(await start());
    assert.deepEqual(await start(), { ok: false, reason: 'in_use', status: 'completed' });
    await pool.query("UPDATE provider_registrations SET status = 'at_risk'");
    assert.deepEqual(await start(), { ok: false, reason: 'in_use', status: 'at_risk' });
  });

  await t.test('a removed registration can start again', async () => {
    await complete(await start());
    await pool.query("UPDATE provider_registrations SET status = 'removed'");
    const again = await start();
    assert.equal(again.ok, true);
    assert.equal((await complete(again)).ok, true);
  });

  await t.test('a signature from a different key is refused, and the correct one then completes', async () => {
    const started = await start();
    const wrong = await complete(started, ethers.Wallet.createRandom());
    assert.equal(wrong.reason, 'bad_signature');
    assert.equal((await complete(started)).ok, true);
  });

  await t.test('a different account cannot complete the record', async () => {
    const started = await start();
    assert.equal((await complete(started, admin, OTHER_USER)).reason, 'not_found');
  });

  await t.test('an expired record is refused', async () => {
    const started = await start();
    await pool.query("UPDATE provider_registrations SET expires_at = NOW() - INTERVAL '1 hour'");
    assert.equal((await complete(started)).reason, 'expired');
  });

  await t.test('a signature for a message older than five minutes sets the record to expired', async () => {
    const started = await start();
    const old = started.message.replace(/Timestamp: \d+/, `Timestamp: ${Date.now() - 6 * 60 * 1000}`);
    await pool.query('UPDATE provider_registrations SET message_to_sign = $1', [old]);
    const result = await completeProviderRegistration(pool, {
      recordId: started.recordId, discordUserId: USER, signature: await admin.signMessage(old)
    });
    assert.equal(result.reason, 'expired');
    const { rows } = await pool.query('SELECT status FROM provider_registrations');
    assert.equal(rows[0].status, 'expired');
  });

  await t.test('a signer that lost its role before the signature is refused', async () => {
    const started = await start();
    chain.setProvider(5, ethers.Wallet.createRandom().address, '0x2222222222222222222222222222222222222222');
    assert.equal((await complete(started)).reason, 'not_eligible');
  });

  const registryB = () => {
    const other = fakeProviderChain({ startBlock: 100, registryAddress: '0x00000000000000000000000000000000000000BB' });
    other.setProvider(5, admin.address, '0x2222222222222222222222222222222222222222');
    other.stake(5, ATTESTER, 150);
    other.setValidating(ATTESTER);
    chains.set('mainnet', other);
  };

  await t.test('a registration stores the StakingRegistry address in lower case', async () => {
    await start();
    const { rows } = await pool.query('SELECT registry FROM provider_registrations');
    assert.deepEqual(rows, [{ registry: '0x00000000000000000000000000000000000000aa' }]);
  });

  await t.test('a registration for an old StakingRegistry does not block a new one for the configured registry', async () => {
    const first = await start();
    assert.equal((await complete(first)).ok, true);
    registryB();
    const again = await start();
    assert.equal(again.ok, true);
    assert.notEqual(again.recordId, first.recordId);
    assert.equal((await complete(again)).ok, true);
    const { rows } = await pool.query('SELECT registry, status FROM provider_registrations ORDER BY id');
    assert.deepEqual(rows, [
      { registry: '0x00000000000000000000000000000000000000aa', status: 'completed' },
      { registry: '0x00000000000000000000000000000000000000bb', status: 'completed' }
    ]);
  });

  await t.test('a record started for a registry that is no longer configured is refused', async () => {
    const started = await start();
    registryB();
    assert.deepEqual(await complete(started), { ok: false, reason: 'registry_changed' });
    const { rows } = await pool.query('SELECT status FROM provider_registrations');
    assert.equal(rows[0].status, 'cancelled');
  });

  await t.test('a provider with no validating attester is refused', async () => {
    chain.setValidating(ATTESTER, false);
    assert.equal((await complete(await start())).reason, 'inactive');
    const { rows } = await pool.query('SELECT status FROM provider_registrations');
    assert.equal(rows[0].status, 'cancelled');
  });
});
