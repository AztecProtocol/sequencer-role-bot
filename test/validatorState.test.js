const test = require('node:test');
const assert = require('node:assert/strict');
const { determineValidatorState } = require('../statusChecker.js');

const FULL_STAKE = 200000n * 10n ** 18n;

test('only the status VALIDATING (1) counts as active', () => {
  // 2 = ZOMBIE, 3 = EXITING: the attester keeps a balance, but does not validate.
  for (const status of [0n, 2n, 3n]) {
    assert.equal(determineValidatorState({ status, attesterView: [status, FULL_STAKE] }, 'mainnet').state, 'INACTIVE', `status ${status}`);
  }
  assert.equal(determineValidatorState({ status: 1n, attesterView: [1n, FULL_STAKE] }, 'mainnet').state, 'HEALTHY');
});
