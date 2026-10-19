const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBot } = require('./helpers/discordHarness.js');
const { fakeProviderChain } = require('./helpers/providerChain.js');

// Needs a disposable Postgres (see README). The harness configures mainnet
// only, so testnet has no RPC URL and no registry.
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';

const OPERATOR = { id: '900000000000000001', username: 'operator' };
const ADDRESS = '0x00000000000000000000000000000000000000a1';

test('a network without configuration', { skip }, async (t) => {
  const bot = await loadBot(url, 'bot_network_availability');
  t.after(() => bot.pool.end());

  // A handler that stops the process fails the test.
  const realExit = process.exit;
  let exitCalls = 0;
  t.beforeEach(async () => {
    await bot.reset();
    exitCalls = 0;
    process.exit = () => { exitCalls += 1; throw new Error('process.exit called'); };
  });
  t.afterEach(() => { process.exit = realExit; });

  const menuValues = (payload) => payload.components
    .flatMap((row) => (row.toJSON ? row.toJSON() : row).components)
    .filter((component) => component.options)
    .flatMap((component) => component.options.map((option) => option.value));

  await t.test('the network menu offers only the configured network', async () => {
    await bot.interact('button', 'register_new_sequencer', OPERATOR);
    assert.deepEqual(menuValues(bot.lastAnswer), ['mainnet']);
  });

  await t.test('the provider network menu offers only a network with a provider chain', async () => {
    bot.providerChains.set('mainnet', fakeProviderChain());
    await bot.interact('button', 'register_provider', OPERATOR);
    assert.deepEqual(menuValues(bot.lastAnswer), ['mainnet']);
  });

  await t.test('without a configured network, the bot says that registration is not available', async () => {
    const saved = process.env.AZTEC_MAINNET_RPC_URL;
    process.env.AZTEC_MAINNET_RPC_URL = '';
    try {
      assert.equal(await bot.interact('button', 'register_new_sequencer', OPERATOR), 'Registration is not available right now.');
      assert.equal(await bot.interact('button', 'register_provider', OPERATOR), 'Registration is not available right now.');
    } finally {
      process.env.AZTEC_MAINNET_RPC_URL = saved;
    }
  });

  await t.test('a testnet details form gets an error and does not stop the process', async () => {
    const answer = await bot.interact('modal', 'registration_modal_testnet', OPERATOR, bot.textInput(ADDRESS));
    assert.equal(exitCalls, 0);
    assert.match(answer, /not available/);
    assert.equal(await bot.record(OPERATOR), undefined);
  });

  await t.test('a signature for a testnet record gets an error and does not stop the process', async () => {
    const { rows } = await bot.pool.query(
      `INSERT INTO pending_registrations (discord_user_id, discord_username, network, wallet_address, message_to_sign, expires_at)
       VALUES ($1, $2, 'Testnet', $3, 'm', NOW() + INTERVAL '1 hour') RETURNING id`, [OPERATOR.id, OPERATOR.username, ADDRESS]);
    const answer = await bot.interact('modal', `sig_sub_${rows[0].id}`, OPERATOR, bot.textInput('0x00'));
    assert.equal(exitCalls, 0);
    assert.match(answer, /not available/);
  });

  await t.test('a testnet Check Status click gets an error and does not stop the process', async () => {
    await bot.pool.query(
      `INSERT INTO pending_registrations (discord_user_id, discord_username, network, wallet_address, message_to_sign, expires_at, status)
       VALUES ($1, $2, 'Testnet', $3, 'm', NOW(), 'completed')`, [OPERATOR.id, OPERATOR.username, ADDRESS]);
    const answer = await bot.interact('button', 'check_status_testnet', OPERATOR);
    assert.equal(exitCalls, 0);
    assert.match(answer, /not available/);
  });

  await t.test('the network config of an unconfigured network is an error, not an exit', () => {
    const { loadNetworkConfig } = require('../statusChecker.js');
    assert.throws(() => loadNetworkConfig('testnet'), /testnet/);
    assert.throws(() => loadNetworkConfig('devnet'), /network/i);
    assert.equal(exitCalls, 0);
  });
});
