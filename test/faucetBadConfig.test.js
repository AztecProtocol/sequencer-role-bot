const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBot } = require('./helpers/discordHarness.js');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';
const OFF = 'The faucet is off at the moment. Staff will announce when it is back.';

// A wrong faucet value turns the faucet off; the rest of the bot keeps running.
// The admin line is posted on the ready event, which the harness never fires:
// faucetConfig.test.js tests the text (loadFaucetConfigSafely).
test('a wrong faucet value turns the faucet off and the bot still loads', { skip }, async () => {
  Object.assign(process.env, {
    FAUCET_ENABLED: 'true',
    FAUCET_CHANNEL_ID: '',
    FAUCET_VERIFIED_ROLE_ID: '555',
    FAUCET_PRIVATE_KEY: '0x' + '11'.repeat(32),
    AZTEC_RPC_URL: 'http://sepolia.invalid'
  });
  const logger = require('../utils/logger.js');
  const wasSilent = logger.silent;
  logger.silent = true; // bot.js logs the configuration error
  let h;
  try {
    h = await loadBot(url, 'faucet_bad_config_test');
  } finally {
    logger.silent = wasSilent;
  }
  await h.reset();
  const member = { id: '400000000000000001', username: 'member' };
  assert.equal(await h.interact('button', 'faucet_request', member, { channelId: '444' }), OFF);
});
