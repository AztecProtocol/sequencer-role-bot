const test = require('node:test');
const assert = require('node:assert/strict');

// Reads Ethereum mainnet. Set TEST_ETH_RPC_URL to run it.
const rpcUrl = process.env.TEST_ETH_RPC_URL;
const skip = rpcUrl ? false : 'TEST_ETH_RPC_URL is not set';

function configureMainnet() {
  Object.assign(process.env, {
    AZTEC_MAINNET_RPC_URL: rpcUrl,
    AZTEC_MAINNET_REGISTRY_CONTRACT: '0x35b22e09ee0390539439e24f06da43d83f90e298',
    AZTEC_MAINNET_STAKING_REGISTRY_CONTRACT: '0x042df8f42790d6943f41c25c2132400fd727f452',
    AZTEC_MAINNET_STAKING_REGISTRY_START_BLOCK: '23786843'
  });
  process.env.AZTEC_MAINNET_ROLLUP_CONTRACT = '';
}

// Set testnet variables for one test, and restore them after it.
// A value of undefined empties the variable (dotenv would fill a deleted one).
async function withTestnetEnv(values, run) {
  const saved = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  const apply = (vars) => {
    for (const [key, value] of Object.entries(vars)) {
      process.env[key] = value === undefined ? '' : value;
    }
  };
  apply(values);
  try {
    return await run();
  } finally {
    apply(saved);
  }
}
const TESTNET = {
  AZTEC_RPC_URL: 'http://chain.invalid',
  AZTEC_STAKING_REGISTRY_CONTRACT: '0x00000000000000000000000000000000000000aa',
  AZTEC_STAKING_REGISTRY_START_BLOCK: '10049301'
};

test('without a StakingRegistry address, provider registration is off for the network', async () => {
  const { forNetwork } = require('../providers/chain.js');
  // An RPC is set, so only the registry is missing.
  await withTestnetEnv({ ...TESTNET, AZTEC_STAKING_REGISTRY_CONTRACT: undefined }, () => {
    assert.equal(forNetwork('testnet'), null);
  });
  await withTestnetEnv(TESTNET, () => {
    assert.notEqual(forNetwork('testnet'), null);
  });
});

test('a missing or malformed StakingRegistry start block turns provider registration off', async () => {
  const { forNetwork } = require('../providers/chain.js');
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await withTestnetEnv({ ...TESTNET, AZTEC_STAKING_REGISTRY_START_BLOCK: undefined }, () => {
      assert.equal(forNetwork('testnet'), null);
    });
    await withTestnetEnv({ ...TESTNET, AZTEC_STAKING_REGISTRY_START_BLOCK: '23,786,843' }, () => {
      assert.equal(forNetwork('testnet'), null);
    });
    await withTestnetEnv({ ...TESTNET, AZTEC_STAKING_REGISTRY_START_BLOCK: '10049301' }, () => {
      const chain = forNetwork('testnet');
      assert.notEqual(chain, null);
      assert.equal(chain.startBlock, 10049301);
    });
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((line) =>
    line.includes('Provider registration is off for testnet: AZTEC_STAKING_REGISTRY_START_BLOCK must be a block number')),
  JSON.stringify(errors));
});

test('the mainnet adapter reads a provider, a Safe, the stake events and the status', { skip }, async () => {
  configureMainnet();
  const { forNetwork } = require('../providers/chain.js');
  const chain = forNetwork('Mainnet');

  // Provider 4 has a Safe admin with five owners (checked 2026-10-17).
  const four = await chain.readConfig(4);
  const owners = await chain.safeOwners(four.admin);
  assert.ok(Array.isArray(owners) && owners.length >= 1);
  // A plain key is not a Safe.
  const five = await chain.readConfig(5);
  assert.equal(await chain.codeAt(five.admin), '0x');
  assert.equal(await chain.safeOwners(five.admin), null);

  // The first stake events come shortly after the registry creation.
  const logs = await chain.getStakeLogs(23791255, 23791255 + 3000);
  assert.ok(logs.length > 0);
  assert.equal(typeof logs[0].providerId, 'number');
  assert.match(logs[0].attester, /^0x[0-9a-fA-F]{40}$/);

  // At least one of the attesters in the scanned events can be read for status.
  assert.equal(typeof (await chain.isValidating(logs[0].attester)), 'boolean');
  assert.ok((await chain.latestBlock()) > 26000000);
});

test('a failed RPC call for Safe owners is an error, not "not a Safe"', async () => {
  // Nothing listens on port 9.
  await withTestnetEnv({ ...TESTNET, AZTEC_RPC_URL: 'http://127.0.0.1:9' }, async () => {
    const { forNetwork } = require('../providers/chain.js');
    await assert.rejects(forNetwork('testnet').safeOwners('0x0000000000000000000000000000000000000001'));
  });
});
