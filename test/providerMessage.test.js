const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { buildProviderMessage, verifyProviderSignature } = require('../providers/message.js');

const NOW = 1791193440000;
const USER = '111111111111111111';
const OTHER = '222222222222222222';
const signer = new ethers.Wallet('0x' + '22'.repeat(32));

function freezeClock(t, now = NOW) {
  t.mock.timers.enable({ apis: ['Date'], now });
}
const recordFor = (message, overrides = {}) => ({
  discord_user_id: USER, provider_id: 5, signer_address: signer.address, message_to_sign: message, ...overrides
});

test('the message names the Discord account, the provider and the signer', (t) => {
  freezeClock(t);
  assert.equal(
    buildProviderMessage(USER, 5, signer.address),
    `Verifying for Aztec Sequencer role as a provider. Discord ID: ${USER}. Provider: 5. Signer: ${signer.address}. Timestamp: ${NOW}`
  );
});

test('the signer completes a registration for the same account', async (t) => {
  freezeClock(t);
  const message = buildProviderMessage(USER, 5, signer.address);
  const result = await verifyProviderSignature(recordFor(message), await signer.signMessage(message), USER);
  assert.equal(result.success, true);
});

test('a signature from a different key is refused', async (t) => {
  freezeClock(t);
  const message = buildProviderMessage(USER, 5, signer.address);
  const other = ethers.Wallet.createRandom();
  const result = await verifyProviderSignature(recordFor(message), await other.signMessage(message), USER);
  assert.equal(result.success, false);
});

test('a record of a different account is refused', async (t) => {
  freezeClock(t);
  const message = buildProviderMessage(USER, 5, signer.address);
  const result = await verifyProviderSignature(recordFor(message), await signer.signMessage(message), OTHER);
  assert.equal(result.success, false);
});

test('a message for a different provider is refused', async (t) => {
  freezeClock(t);
  const message = buildProviderMessage(USER, 6, signer.address);
  const result = await verifyProviderSignature(recordFor(message), await signer.signMessage(message), USER);
  assert.equal(result.success, false);
});

test('a message that is more than five minutes old is refused', async (t) => {
  freezeClock(t);
  const message = buildProviderMessage(USER, 5, signer.address);
  const signature = await signer.signMessage(message);
  t.mock.timers.setTime(NOW + 6 * 60 * 1000);
  const result = await verifyProviderSignature(recordFor(message), signature, USER);
  assert.equal(result.success, false);
  assert.match(result.error, /expired/);
});
