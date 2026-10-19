const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createEmptyDatabase } = require('./helpers/database.js');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';

test('role access with provider registrations', { skip }, async (t) => {
  const pool = new Pool({ connectionString: await createEmptyDatabase(url, 'bot_role_access') });
  t.after(() => pool.end());
  await require('../db/migrate.js').migrate(pool);
  const { keepsRole, managerNetworks } = require('../db/roleAccess.js');
  t.beforeEach(() => pool.query('TRUNCATE pending_registrations, provider_registrations, colleagues RESTART IDENTITY'));

  const provider = (user, status, network = 'Mainnet') => pool.query(
    `INSERT INTO provider_registrations (discord_user_id, network, registry, provider_id, signer_address, signer_kind, message_to_sign, status, expires_at)
     VALUES ($1, $2, '0xaa', 5, '0xabc', 'admin', 'm', $3, NOW())`, [user, network, status]);
  const colleague = (manager, user) => pool.query(
    `INSERT INTO colleagues (manager_discord_id, colleague_user_id, status) VALUES ($1, $2, 'active')`, [manager, user]);

  await t.test('a provider registration in use keeps the role for its network only', async () => {
    await provider('1', 'at_risk');
    assert.equal(await keepsRole(pool, '1', 'mainnet'), true);
    assert.equal(await keepsRole(pool, '1', 'testnet'), false);
  });

  await t.test('a removed provider registration does not keep the role', async () => {
    await provider('1', 'removed');
    assert.equal(await keepsRole(pool, '1', 'mainnet'), false);
  });

  await t.test('an active colleague of a provider keeps the role', async () => {
    await provider('1', 'completed');
    await colleague('1', '2');
    assert.equal(await keepsRole(pool, '2', 'mainnet'), true);
  });

  await t.test('the networks of a manager include completed provider registrations', async () => {
    await provider('1', 'completed', 'Testnet');
    await provider('1', 'pending', 'Mainnet');
    assert.deepEqual(await managerNetworks(pool, '1'), ['Testnet']);
  });
});
