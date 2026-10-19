const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { loadBot } = require('./helpers/discordHarness.js');
const { fakeProviderChain } = require('./helpers/providerChain.js');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';
const PROVIDER = { id: '900000000000000001', username: 'provider' };
const OTHER = { id: '900000000000000002', username: 'other' };
const ATTESTER = '0xa100000000000000000000000000000000000001';

test('provider registration in Discord', { skip }, async (t) => {
  const bot = await loadBot(url, 'bot_provider_flow');
  t.after(() => bot.pool.end());

  let admin;
  let recipient;
  let chain;
  t.beforeEach(async () => {
    await bot.reset();
    admin = ethers.Wallet.createRandom();
    recipient = ethers.Wallet.createRandom();
    chain = fakeProviderChain({ startBlock: 100 });
    chain.setProvider(5, admin.address, recipient.address);
    chain.stake(5, ATTESTER, 150);
    chain.setValidating(ATTESTER);
    bot.providerChains.set('mainnet', chain);
  });

  async function registerProvider(user, signer, { network = 'mainnet', providerId = '5', signWith = signer } = {}) {
    await bot.interact('button', 'register_provider', user);
    const opened = await bot.interact('select', 'provider_network_select', user, { values: [network] });
    assert.equal(opened, `modal provider_details_modal_${network}`);
    const details = await bot.interact('modal', `provider_details_modal_${network}`, user,
      bot.form({ provider_id: providerId, signer_address: signer.address }));
    const { rows } = await bot.pool.query(
      'SELECT id, message_to_sign FROM provider_registrations WHERE discord_user_id = $1 ORDER BY id DESC LIMIT 1', [user.id]);
    if (!rows.length) return { details };
    assert.equal(await bot.interact('button', `provider_submit_signature_${rows[0].id}`, user), `modal provider_sig_sub_${rows[0].id}`);
    const result = await bot.interact('modal', `provider_sig_sub_${rows[0].id}`, user,
      bot.textInput(await signWith.signMessage(rows[0].message_to_sign)));
    return { details, result, record: rows[0] };
  }
  const hasRole = (user, role = bot.MAINNET_ROLE) => bot.rolesOf(user.id).has(role);

  await t.test('the welcome panel has a provider button', async () => {
    await bot.interact('command', undefined, PROVIDER, { commandName: 'register' });
    const ids = bot.lastAnswer.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
    assert.ok(ids.includes('register_provider'), JSON.stringify(ids));
  });

  await t.test('a provider admin who signs gets the mainnet role', async () => {
    await registerProvider(PROVIDER, admin);
    assert.equal(hasRole(PROVIDER), true);
  });

  await t.test('a provider rewards recipient who signs gets the mainnet role', async () => {
    await registerProvider(PROVIDER, recipient);
    assert.equal(hasRole(PROVIDER), true);
  });

  await t.test('a testnet provider gets the testnet role', async () => {
    bot.providerChains.set('testnet', chain);
    await registerProvider(PROVIDER, admin, { network: 'testnet' });
    assert.equal(hasRole(PROVIDER, bot.TESTNET_ROLE), true);
    assert.equal(hasRole(PROVIDER), false);
  });

  await t.test('an address with no role in the provider is refused at the details step', async () => {
    const stranger = ethers.Wallet.createRandom();
    const { details } = await registerProvider(PROVIDER, stranger);
    assert.match(details, /not the admin or the rewards recipient/);
    assert.equal(hasRole(PROVIDER), false);
  });

  await t.test('a start with an address that is not eligible counts against the rate limit', async () => {
    const { details } = await registerProvider(PROVIDER, ethers.Wallet.createRandom());
    assert.match(details, /not the admin or the rewards recipient/);
    const { rows } = await bot.pool.query('SELECT COUNT(*)::int AS n FROM signature_attempts WHERE discord_user_id = $1', [PROVIDER.id]);
    assert.equal(rows[0].n, 1);
  });

  await t.test('a provider with no active attester gets no role', async () => {
    chain.setValidating(ATTESTER, false);
    const { result } = await registerProvider(PROVIDER, admin);
    assert.match(result, /no active attester/);
    assert.equal(hasRole(PROVIDER), false);
  });

  await t.test('a wrong signature gives no role', async () => {
    const { result } = await registerProvider(PROVIDER, admin, { signWith: ethers.Wallet.createRandom() });
    assert.match(result, /Signature verification failed/);
    assert.equal(hasRole(PROVIDER), false);
  });

  await t.test('the signature of a provider admin gives no role to a different account', async () => {
    const { record } = await registerProvider(PROVIDER, admin, { signWith: ethers.Wallet.createRandom() });
    const signature = await admin.signMessage(record.message_to_sign);
    await bot.interact('modal', `provider_sig_sub_${record.id}`, OTHER, bot.textInput(signature));
    assert.equal(hasRole(OTHER), false);
  });

  await t.test('a network without a StakingRegistry says that provider registration is not available', async () => {
    // The menu does not offer the network. A select or a details form for it is refused.
    assert.match(await bot.interact('select', 'provider_network_select', PROVIDER, { values: ['testnet'] }), /not available for this network/);
    const details = await bot.interact('modal', 'provider_details_modal_testnet', PROVIDER,
      bot.form({ provider_id: '5', signer_address: admin.address }));
    assert.match(details, /not available for this network/);
  });

  await t.test('a registration at risk whose role was removed by hand gets the in_use reply and no role', async () => {
    await registerProvider(PROVIDER, admin);
    await bot.pool.query("UPDATE provider_registrations SET status = 'at_risk', at_risk_since = NOW()");
    bot.rolesOf(PROVIDER.id).delete(bot.MAINNET_ROLE);
    await bot.pool.query('TRUNCATE signature_attempts');
    const again = await bot.interact('modal', 'provider_details_modal_mainnet', PROVIDER,
      bot.form({ provider_id: '5', signer_address: admin.address }));
    assert.equal(again, 'ℹ️ You already have the role through this provider.');
    assert.equal(hasRole(PROVIDER), false);
  });

  await t.test('a failed role grant is reported, and a new registration gives the role', async () => {
    bot.failRoleGrants = true;
    const { result, record } = await registerProvider(PROVIDER, admin);
    assert.match(result, /could not give the role/);
    const { rows } = await bot.pool.query('SELECT status FROM provider_registrations WHERE id = $1', [record.id]);
    assert.equal(rows[0].status, 'completed');
    assert.equal(hasRole(PROVIDER), false);
    assert.ok(bot.adminMessages.some((m) => /Role grant failed/.test(m)), JSON.stringify(bot.adminMessages));
    bot.failRoleGrants = false;
    await bot.pool.query('TRUNCATE signature_attempts');
    const again = await bot.interact('modal', 'provider_details_modal_mainnet', PROVIDER,
      bot.form({ provider_id: '5', signer_address: admin.address }));
    assert.notEqual(again, undefined);
    assert.equal(hasRole(PROVIDER), true);
    assert.ok(bot.adminMessages.some((m) => /Provider role restored/.test(m)), JSON.stringify(bot.adminMessages));
  });
});
