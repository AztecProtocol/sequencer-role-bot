const test = require('node:test');
const assert = require('node:assert/strict');

// Every entry point (bot.js, cronJob.js, statusChecker.js) loads config.js
// with require(). These tests fail if the module cannot be loaded that way.

test('mainnet full stake is 200,000 tokens in wei', () => {
  const { getFullStake } = require('../config.js');
  assert.equal(getFullStake('mainnet'), 200000000000000000000000n);
});

test('network names are matched without regard to case', () => {
  const { getTokenName } = require('../config.js');
  assert.equal(getTokenName('Mainnet'), 'AZTEC');
  assert.equal(getTokenName('TESTNET'), 'STK');
});

test('an unknown network is rejected', () => {
  const { getNetworkConfig } = require('../config.js');
  assert.throws(() => getNetworkConfig('devnet'), /Unsupported network/);
});

test('each network maps to its own role id from the environment', () => {
  const { getDiscordRoleId } = require('../config.js');
  process.env.TESTNET_SEQUENCER_ROLE_ID = '111';
  process.env.MAINNET_SEQUENCER_ROLE_ID = '222';
  assert.equal(getDiscordRoleId('testnet'), '111');
  assert.equal(getDiscordRoleId('mainnet'), '222');
});
