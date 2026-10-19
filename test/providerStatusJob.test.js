const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { loadBot } = require('./helpers/discordHarness.js');
const { fakeProviderChain } = require('./helpers/providerChain.js');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';
const PROVIDER = { id: '900000000000000001', username: 'provider' };
const COLLEAGUE = { id: '900000000000000003', username: 'colleague' };
const ATTESTER = '0xa100000000000000000000000000000000000001';

test('status job for provider registrations', { skip }, async (t) => {
  const bot = await loadBot(url, 'bot_provider_status_job');
  t.after(() => bot.pool.end());

  let admin;
  let chain;
  t.beforeEach(async () => {
    await bot.reset();
    admin = ethers.Wallet.createRandom();
    chain = fakeProviderChain({ startBlock: 100 });
    chain.setProvider(5, admin.address, '0x2222222222222222222222222222222222222222');
    chain.stake(5, ATTESTER, 150);
    chain.setValidating(ATTESTER);
    bot.providerChains.set('mainnet', chain);
  });

  async function registeredProvider() {
    await bot.interact('modal', 'provider_details_modal_mainnet', PROVIDER,
      bot.form({ provider_id: '5', signer_address: admin.address }));
    const { rows } = await bot.pool.query('SELECT id, message_to_sign FROM provider_registrations');
    await bot.interact('modal', `provider_sig_sub_${rows[0].id}`, PROVIDER,
      bot.textInput(await admin.signMessage(rows[0].message_to_sign)));
    assert.equal(hasRole(PROVIDER), true);
  }
  const hasRole = (user) => bot.rolesOf(user.id).has(bot.MAINNET_ROLE);
  const status = async () => (await bot.pool.query('SELECT status FROM provider_registrations')).rows[0].status;
  const messages = () => bot.directMessages.map((m) => m.title);
  const atRiskFor = (days) =>
    bot.pool.query(`UPDATE provider_registrations SET at_risk_since = NOW() - INTERVAL '${days} days'`);

  await t.test('an active provider keeps the role and gets no message', async () => {
    await registeredProvider();
    await bot.job.runGuardianCheck();
    assert.equal(hasRole(PROVIDER), true);
    assert.deepEqual(messages(), []);
  });

  await t.test('a provider with no active attester gets one alert and keeps the role', async () => {
    await registeredProvider();
    chain.setValidating(ATTESTER, false);
    await bot.job.runGuardianCheck();
    await bot.job.runGuardianCheck();
    assert.equal(await status(), 'at_risk');
    assert.equal(hasRole(PROVIDER), true);
    assert.deepEqual(messages(), ['🚨 Provider Alert: No Active Attester']);
  });

  await t.test('a provider role removal that Discord refuses is reported and done in the next run', async () => {
    await registeredProvider();
    chain.setValidating(ATTESTER, false);
    await bot.job.runGuardianCheck();
    await atRiskFor(7);

    bot.failRoleRemovals = true;
    await bot.job.runGuardianCheck();
    assert.equal(await status(), 'at_risk');
    assert.equal(hasRole(PROVIDER), true);
    assert.ok(bot.adminMessages.some((m) => m.includes('⚠️ Role removal failed for provider (900000000000000001) on Mainnet: Service Unavailable. The job tries again in the next run.')), bot.adminMessages.join('\n'));
    assert.deepEqual(messages(), ['🚨 Provider Alert: No Active Attester']);

    bot.failRoleRemovals = false;
    await bot.job.runGuardianCheck();
    assert.equal(await status(), 'removed');
    assert.equal(hasRole(PROVIDER), false);
    assert.deepEqual(messages(), ['🚨 Provider Alert: No Active Attester', '❌ Sequencer Role Removed']);
  });

  await t.test('the role is removed after seven days with no active attester', async () => {
    await registeredProvider();
    chain.setValidating(ATTESTER, false);
    await bot.job.runGuardianCheck();
    await atRiskFor(7);
    await bot.job.runGuardianCheck();
    assert.equal(await status(), 'removed');
    assert.equal(hasRole(PROVIDER), false);
    assert.deepEqual(messages(), ['🚨 Provider Alert: No Active Attester', '❌ Sequencer Role Removed']);
  });

  await t.test('a provider that becomes active again leaves the countdown', async () => {
    await registeredProvider();
    chain.setValidating(ATTESTER, false);
    await bot.job.runGuardianCheck();
    await atRiskFor(6);
    chain.setValidating(ATTESTER, true);
    await bot.job.runGuardianCheck();
    assert.equal(await status(), 'completed');
    assert.equal(hasRole(PROVIDER), true);
    assert.deepEqual(messages(), ['🚨 Provider Alert: No Active Attester', '✅ Provider Active Again']);
  });

  await t.test('a signer that is no longer admin or recipient starts the countdown', async () => {
    await registeredProvider();
    chain.setProvider(5, ethers.Wallet.createRandom().address, '0x2222222222222222222222222222222222222222');
    await bot.job.runGuardianCheck();
    assert.equal(await status(), 'at_risk');
    assert.deepEqual(messages(), ['🚨 Provider Alert: Signer Changed']);
  });

  await t.test('an RPC failure changes nothing', async () => {
    await registeredProvider();
    chain.setValidating(ATTESTER, false);
    chain.state.failNext = 100000;
    chain.stake(5, ATTESTER, 200); // a new block, so the sync must read
    await bot.job.runGuardianCheck();
    assert.equal(await status(), 'completed');
    assert.deepEqual(messages(), []);
  });

  await t.test('a provider keeps the role when its operator registration is removed', async () => {
    await registeredProvider();
    const wallet = ethers.Wallet.createRandom();
    bot.chain.set(wallet.address.toLowerCase(), 'HEALTHY');
    await bot.pool.query('TRUNCATE signature_attempts');
    await bot.register(PROVIDER, wallet);
    bot.chain.set(wallet.address.toLowerCase(), 'INACTIVE');
    await bot.job.runGuardianCheck();
    await bot.pool.query("UPDATE pending_registrations SET at_risk_since = NOW() - INTERVAL '7 days'");
    await bot.job.runGuardianCheck();
    assert.equal((await bot.record(PROVIDER)).status, 'removed');
    assert.equal(hasRole(PROVIDER), true);
  });

  await t.test('a colleague of a provider gets the role and loses it with the provider', async () => {
    await registeredProvider();
    await bot.interact('modal', 'manage_colleagues_modal', PROVIDER, bot.form({ discord_id_1: COLLEAGUE.id }));
    assert.equal(hasRole(COLLEAGUE), true);
    chain.setValidating(ATTESTER, false);
    await bot.job.runGuardianCheck();
    await atRiskFor(7);
    await bot.job.runGuardianCheck();
    assert.equal(hasRole(COLLEAGUE), false);
  });

  async function managerWithBothRegistrations() {
    await registeredProvider();
    const wallet = ethers.Wallet.createRandom();
    bot.chain.set(wallet.address.toLowerCase(), 'HEALTHY');
    await bot.pool.query('TRUNCATE signature_attempts');
    await bot.register(PROVIDER, wallet);
    assert.equal((await bot.record(PROVIDER)).status, 'completed');
    await bot.interact('modal', 'manage_colleagues_modal', PROVIDER, bot.form({ discord_id_1: COLLEAGUE.id }));
    assert.equal(hasRole(COLLEAGUE), true);
    return wallet;
  }

  await t.test('colleagues keep the role when the provider registration is removed but the manager keeps an operator registration', async () => {
    await managerWithBothRegistrations();
    chain.setValidating(ATTESTER, false);
    await bot.job.runGuardianCheck();
    await atRiskFor(7);
    await bot.job.runGuardianCheck();
    assert.equal(await status(), 'removed');
    assert.equal(hasRole(PROVIDER), true);
    assert.equal(hasRole(COLLEAGUE), true);
  });

  await t.test('colleagues keep the role when the operator registration is removed but the manager keeps a provider registration', async () => {
    const wallet = await managerWithBothRegistrations();
    bot.chain.set(wallet.address.toLowerCase(), 'INACTIVE');
    await bot.job.runGuardianCheck();
    await bot.pool.query("UPDATE pending_registrations SET at_risk_since = NOW() - INTERVAL '7 days'");
    await bot.job.runGuardianCheck();
    assert.equal((await bot.record(PROVIDER)).status, 'removed');
    assert.equal(await status(), 'completed');
    assert.equal(hasRole(PROVIDER), true);
    assert.equal(hasRole(COLLEAGUE), true);
  });

  await t.test('a registration for an old StakingRegistry gets a registry alert, and a new registration keeps the role', async () => {
    await registeredProvider();
    const newRegistry = fakeProviderChain({ startBlock: 100, registryAddress: '0x00000000000000000000000000000000000000BB' });
    newRegistry.setProvider(5, admin.address, '0x2222222222222222222222222222222222222222');
    newRegistry.stake(5, ATTESTER, 150);
    newRegistry.setValidating(ATTESTER);
    bot.providerChains.set('mainnet', newRegistry);

    await bot.job.runGuardianCheck();
    assert.equal(await status(), 'at_risk');
    assert.deepEqual(messages(), ['🚨 Provider Alert: Registry Changed']);

    await bot.pool.query('TRUNCATE signature_attempts');
    await bot.interact('modal', 'provider_details_modal_mainnet', PROVIDER,
      bot.form({ provider_id: '5', signer_address: admin.address }));
    const { rows } = await bot.pool.query('SELECT id, message_to_sign FROM provider_registrations ORDER BY id DESC LIMIT 1');
    await bot.interact('modal', `provider_sig_sub_${rows[0].id}`, PROVIDER,
      bot.textInput(await admin.signMessage(rows[0].message_to_sign)));
    const statuses = async () =>
      (await bot.pool.query('SELECT registry, status FROM provider_registrations ORDER BY id')).rows;
    assert.deepEqual(await statuses(), [
      { registry: '0x00000000000000000000000000000000000000aa', status: 'at_risk' },
      { registry: '0x00000000000000000000000000000000000000bb', status: 'completed' }
    ]);

    await bot.pool.query("UPDATE provider_registrations SET at_risk_since = NOW() - INTERVAL '7 days' WHERE status = 'at_risk'");
    await bot.job.runGuardianCheck();
    assert.deepEqual(await statuses(), [
      { registry: '0x00000000000000000000000000000000000000aa', status: 'removed' },
      { registry: '0x00000000000000000000000000000000000000bb', status: 'completed' }
    ]);
    assert.equal(hasRole(PROVIDER), true);
  });
});
