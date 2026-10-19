const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { execFile } = require('node:child_process');
const path = require('node:path');

// Reads Ethereum mainnet. Set TEST_ETH_RPC_URL to run it.
const rpcUrl = process.env.TEST_ETH_RPC_URL;
const skip = rpcUrl ? false : 'TEST_ETH_RPC_URL is not set';
const MAINNET_REGISTRY = '0x35b22e09ee0390539439e24f06da43d83f90e298';

test('an active mainnet attester is read with only the registry address configured', { skip }, async () => {
  process.env.AZTEC_MAINNET_RPC_URL = rpcUrl;
  process.env.AZTEC_MAINNET_REGISTRY_CONTRACT = MAINNET_REGISTRY;
  process.env.AZTEC_MAINNET_ROLLUP_CONTRACT = '';

  // Find an active attester without the code under test.
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const registry = new ethers.Contract(MAINNET_REGISTRY, ['function getCanonicalRollup() view returns (address)'], provider);
  const rollup = new ethers.Contract(await registry.getCanonicalRollup(), ['function getAttesterAtIndex(uint256) view returns (address)'], provider);
  const attester = await rollup.getAttesterAtIndex(0);

  const { loadNetworkConfig, fetchOnChainStatus, determineValidatorState } = require('../statusChecker.js');
  const result = await fetchOnChainStatus(attester, loadNetworkConfig('mainnet'));

  assert.equal(result.success, true, JSON.stringify(result.data.error));
  assert.equal(result.data.status, 1n); // 1 = VALIDATING
  assert.notEqual(determineValidatorState(result.data, 'mainnet').state, 'INACTIVE');
});

test('the status command reports an attester with only the RPC and the registry configured', { skip }, async () => {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const registry = new ethers.Contract(MAINNET_REGISTRY, ['function getCanonicalRollup() view returns (address)'], provider);
  const rollup = new ethers.Contract(await registry.getCanonicalRollup(), ['function getAttesterAtIndex(uint256) view returns (address)'], provider);
  const attester = await rollup.getAttesterAtIndex(0);

  const env = {
    PATH: process.env.PATH,
    AZTEC_MAINNET_RPC_URL: rpcUrl,
    AZTEC_MAINNET_REGISTRY_CONTRACT: MAINNET_REGISTRY
  };
  const { code, output } = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(__dirname, '..', 'statusChecker.js'), '--network', 'mainnet', attester],
      { env, cwd: require('node:os').tmpdir() },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, output: stdout + stderr })
    );
  });

  assert.equal(code, 0, output.replaceAll(rpcUrl, '<rpc>'));
  assert.match(output, /Validator state: (HEALTHY|SLASHED)/);
  assert.ok(!output.includes(rpcUrl), 'the output must not contain the RPC URL');
});
