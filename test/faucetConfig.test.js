const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFaucetConfig } = require('../faucet/config.js');

const valid = {
  FAUCET_ENABLED: 'true',
  FAUCET_CHANNEL_ID: '1400000000000000001',
  FAUCET_VERIFIED_ROLE_ID: '1400000000000000002',
  FAUCET_PRIVATE_KEY: '0x' + '11'.repeat(32),
  AZTEC_RPC_URL: 'http://sepolia.invalid',
  TESTNET_SEQUENCER_ROLE_ID: '111',
  MAINNET_SEQUENCER_ROLE_ID: '222'
};

test('the faucet is off unless FAUCET_ENABLED is exactly true', () => {
  assert.deepEqual(loadFaucetConfig({}), { enabled: false });
  assert.deepEqual(loadFaucetConfig({ FAUCET_ENABLED: 'yes' }), { enabled: false });
  assert.deepEqual(loadFaucetConfig({ FAUCET_ENABLED: '' }), { enabled: false });
});

test('the starting values apply when only the required values are set', () => {
  const config = loadFaucetConfig(valid);
  assert.equal(config.enabled, true);
  assert.equal(config.channelId, '1400000000000000001');
  assert.equal(config.verifiedRoleId, '1400000000000000002');
  assert.equal(config.testnetRoleId, '111');
  assert.equal(config.tokenAddress, '0x5595cb9ED193cAc2C0Bc5393313bc6115817954B');
  assert.equal(config.rpcUrl, 'http://sepolia.invalid');
  assert.equal(config.minAccountDays, 90);
  assert.equal(config.minServerDays, 7);
  assert.deepEqual(config.member, { amount: 200000n, waitHours: 2160, max30d: 200000n });
  assert.deepEqual(config.operator, { amount: 200000n, waitHours: 168, max30d: 400000n });
  assert.equal(config.walletMax30d, 400000n);
  assert.equal(config.globalMax24h, 5000000n);
  assert.equal(config.alertMinToken, 2000000n);
  assert.equal(config.alertMinEthWei, 50000000000000000n);
});

test('an empty value counts as unset and takes the starting value', () => {
  const config = loadFaucetConfig({ ...valid, FAUCET_AMOUNT: '', FAUCET_MIN_SERVER_DAYS: '' });
  assert.equal(config.member.amount, 200000n);
  assert.equal(config.minServerDays, 7);
});

test('a server age of 0 days is allowed, an account age of 0 days too', () => {
  const config = loadFaucetConfig({ ...valid, FAUCET_MIN_SERVER_DAYS: '0', FAUCET_MIN_ACCOUNT_DAYS: '0' });
  assert.equal(config.minServerDays, 0);
  assert.equal(config.minAccountDays, 0);
});

test('every missing or wrong required value is named in one error', () => {
  assert.throws(
    () => loadFaucetConfig({ FAUCET_ENABLED: 'true' }),
    (error) => ['FAUCET_CHANNEL_ID', 'FAUCET_VERIFIED_ROLE_ID', 'FAUCET_PRIVATE_KEY', 'AZTEC_RPC_URL']
      .every((name) => error.message.includes(name))
  );
});

test('a wrong private key, token address, amount or ETH value is refused', () => {
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_PRIVATE_KEY: '0x1234' }), /FAUCET_PRIVATE_KEY/);
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_TOKEN_ADDRESS: '0xnope' }), /FAUCET_TOKEN_ADDRESS/);
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_AMOUNT: '0' }), /FAUCET_AMOUNT/);
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_MEMBER_WAIT_HOURS: '1.5' }), /FAUCET_MEMBER_WAIT_HOURS/);
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_ALERT_MIN_ETH: 'a lot' }), /FAUCET_ALERT_MIN_ETH/);
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_ALERT_MIN_ETH: '-0.05' }), /FAUCET_ALERT_MIN_ETH/);
});

test('maximums below one claim are refused', () => {
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_OPERATOR_MAX_30D: '100000' }), /FAUCET_OPERATOR_MAX_30D/);
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_WALLET_MAX_30D: '100000' }), /FAUCET_WALLET_MAX_30D/);
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_GLOBAL_MAX_24H: '100000' }), /FAUCET_GLOBAL_MAX_24H/);
  // A value that does not parse is named once, as not a number.
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_WALLET_MAX_30D: 'x' }),
    (error) => !error.message.includes('FAUCET_WALLET_MAX_30D must not be below'));
});

test('a config without the testnet role gives a warning, the mainnet role does not matter', () => {
  assert.deepEqual(loadFaucetConfig(valid).warnings, []);
  const config = loadFaucetConfig({ ...valid, TESTNET_SEQUENCER_ROLE_ID: '' });
  assert.equal(config.warnings.length, 1);
  assert.ok(config.warnings[0].includes('nobody gets the operator rule'));
  assert.deepEqual(loadFaucetConfig({ ...valid, MAINNET_SEQUENCER_ROLE_ID: '' }).warnings, []);
});

test('the gas price ceiling is 100 gwei unless set, as a whole number above 0', () => {
  assert.equal(loadFaucetConfig(valid).maxFeeWei, 100n * 10n ** 9n);
  assert.equal(loadFaucetConfig({ ...valid, FAUCET_MAX_FEE_GWEI: '30' }).maxFeeWei, 30n * 10n ** 9n);
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_MAX_FEE_GWEI: '1.5' }), /FAUCET_MAX_FEE_GWEI/);
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_MAX_FEE_GWEI: '0' }), /FAUCET_MAX_FEE_GWEI/);
});

test('a wrong value turns the faucet off with a notice that names the variable, not its value', () => {
  const { loadFaucetConfigSafely } = require('../faucet/config.js');
  const ok = loadFaucetConfigSafely(valid);
  assert.equal(ok.config.enabled, true);
  assert.equal(ok.notice, null);
  const secret = '0x' + 'ab'.repeat(31);
  const bad = loadFaucetConfigSafely({ ...valid, FAUCET_PRIVATE_KEY: secret });
  assert.deepEqual(bad.config, { enabled: false });
  assert.equal(bad.notice, '⚠️ The faucet is off: its configuration is invalid. FAUCET_PRIVATE_KEY must be 0x followed by 64 hex characters');
  assert.ok(!bad.notice.includes(secret));
  assert.deepEqual(loadFaucetConfigSafely({}), { config: { enabled: false }, notice: null });
});

test('a private key outside the curve range turns the faucet off and is not shown', () => {
  const { loadFaucetConfigSafely } = require('../faucet/config.js');
  for (const secret of ['0x' + '00'.repeat(32), '0x' + 'ff'.repeat(32)]) {
    const bad = loadFaucetConfigSafely({ ...valid, FAUCET_PRIVATE_KEY: secret });
    assert.deepEqual(bad.config, { enabled: false });
    assert.equal(bad.notice, '⚠️ The faucet is off: its configuration is invalid. FAUCET_PRIVATE_KEY is not a valid private key');
    assert.ok(!bad.notice.includes(secret));
  }
});

test('a wait above 87600 hours is refused and names the variable', () => {
  assert.equal(loadFaucetConfig({ ...valid, FAUCET_MEMBER_WAIT_HOURS: '87600' }).member.waitHours, 87600);
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_MEMBER_WAIT_HOURS: '87601' }), /FAUCET_MEMBER_WAIT_HOURS must be at most 87600/);
  assert.throws(() => loadFaucetConfig({ ...valid, FAUCET_OPERATOR_WAIT_HOURS: '87601' }), /FAUCET_OPERATOR_WAIT_HOURS must be at most 87600/);
});

test('a member wait below 720 hours gives a warning', () => {
  const config = loadFaucetConfig({ ...valid, FAUCET_MEMBER_WAIT_HOURS: '719' });
  assert.deepEqual(config.warnings, ['FAUCET_MEMBER_WAIT_HOURS is below 720: a member still gets at most one claim in 30 days']);
  assert.deepEqual(loadFaucetConfig({ ...valid, FAUCET_MEMBER_WAIT_HOURS: '720' }).warnings, []);
});
