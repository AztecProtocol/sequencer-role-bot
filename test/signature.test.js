const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { generateSignatureMessage } = require('../db/signatureAttempts.js');
const { verifySignature, verifyRegistrationSignature } = require('../verifySignature.js');

const NOW = 1791193440000;
const OPERATOR_ID = '111111111111111111';
const OTHER_ID = '222222222222222222';
// Fixed test key, never funded.
const operator = new ethers.Wallet('0x' + '11'.repeat(32));
const OPERATOR_WALLET = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';

function freezeClock(t, now = NOW) {
  t.mock.timers.enable({ apis: ['Date'], now });
}

test('the message names the Discord account and the wallet it is for', (t) => {
  freezeClock(t);
  assert.equal(
    generateSignatureMessage(OPERATOR_ID, OPERATOR_WALLET),
    `Verifying for Aztec Sequencer role. Discord ID: ${OPERATOR_ID}. Wallet: ${OPERATOR_WALLET}. Timestamp: ${NOW}`
  );
});

test('a signature made for one Discord account is refused for a different account', async (t) => {
  freezeClock(t);
  assert.equal(operator.address, OPERATOR_WALLET);

  // The operator registers and signs the message from the bot.
  const operatorSignature = await operator.signMessage(generateSignatureMessage(OPERATOR_ID, OPERATOR_WALLET));

  // At the same instant, a different account starts a registration, gives
  // the operator wallet as its own, and submits the operator signature.
  const otherMessage = generateSignatureMessage(OTHER_ID, OPERATOR_WALLET);
  const result = await verifySignature(otherMessage, operatorSignature, OPERATOR_WALLET);

  assert.equal(result.success, false);
});

test('the wallet owner completes a registration for the same account', async (t) => {
  freezeClock(t);
  const message = generateSignatureMessage(OPERATOR_ID, OPERATOR_WALLET);
  const record = { discord_user_id: OPERATOR_ID, wallet_address: OPERATOR_WALLET, message_to_sign: message };

  const result = await verifyRegistrationSignature(record, await operator.signMessage(message), OPERATOR_ID);

  assert.equal(result.success, true);
});

test('a stored message that does not name the submitting account is refused, even with a valid signature', async (t) => {
  freezeClock(t);
  // Shape of the messages made before the account was part of the text.
  const unbound = `Verifying for Aztec Sequencer role. Timestamp: ${NOW}`;
  const record = { discord_user_id: OTHER_ID, wallet_address: OPERATOR_WALLET, message_to_sign: unbound };

  const result = await verifyRegistrationSignature(record, await operator.signMessage(unbound), OTHER_ID);

  assert.equal(result.success, false);
});

test('a registration record is refused for an account that does not own the record', async (t) => {
  freezeClock(t);
  const message = generateSignatureMessage(OPERATOR_ID, OPERATOR_WALLET);
  const record = { discord_user_id: OPERATOR_ID, wallet_address: OPERATOR_WALLET, message_to_sign: message };

  const result = await verifyRegistrationSignature(record, await operator.signMessage(message), OTHER_ID);

  assert.equal(result.success, false);
});

test('the wallet in the record matches without regard to letter case', async (t) => {
  freezeClock(t);
  const message = generateSignatureMessage(OPERATOR_ID, OPERATOR_WALLET.toLowerCase());
  const record = { discord_user_id: OPERATOR_ID, wallet_address: OPERATOR_WALLET, message_to_sign: message };

  const result = await verifyRegistrationSignature(record, await operator.signMessage(message), OPERATOR_ID);

  assert.equal(result.success, true);
});

test('a signature is refused when the message is more than five minutes old', async (t) => {
  freezeClock(t);
  const message = generateSignatureMessage(OPERATOR_ID, OPERATOR_WALLET);
  const signature = await operator.signMessage(message);
  const record = { discord_user_id: OPERATOR_ID, wallet_address: OPERATOR_WALLET, message_to_sign: message };

  t.mock.timers.setTime(NOW + 6 * 60 * 1000);
  const result = await verifyRegistrationSignature(record, signature, OPERATOR_ID);

  assert.equal(result.success, false);
  assert.match(result.error, /expired/);
});
