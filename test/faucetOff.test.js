const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBot } = require('./helpers/discordHarness.js');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';
const OFF = 'The faucet is off at the moment. Staff will announce when it is back.';

// FAUCET_ENABLED is not set (isolateEnv gives ''): the faucet is off.
test('with the faucet off, the button, /faucet-panel and /faucet-reset say so', { skip }, async () => {
  const h = await loadBot(url, 'faucet_off_test');
  await h.reset();
  const member = { id: '400000000000000001', username: 'member' };
  assert.equal(await h.interact('button', 'faucet_request', member, { channelId: '444' }), OFF);
  assert.equal(await h.interact('command', 'faucet-panel', { id: '9', username: 'staff' }, { commandName: 'faucet-panel', channelId: '444' }), OFF);
  const options = { getUser: () => ({ id: '5', username: 'member' }), getString: () => null };
  assert.equal(await h.interact('command', 'faucet-reset', { id: '9', username: 'staff' }, { commandName: 'faucet-reset', options }), OFF);
});
