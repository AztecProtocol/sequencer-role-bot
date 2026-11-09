const test = require('node:test');
const assert = require('node:assert/strict');
const { createSender } = require('../faucet/sender.js');

// A real transfer of 1 STK on Sepolia, from the test wallet to itself.
//   TEST_SEPOLIA_RPC_URL=<sepolia rpc> TEST_FAUCET_PRIVATE_KEY=<funded test key> npm test
// The wallet needs at least 1 STK and a little Sepolia ETH.
const rpcUrl = process.env.TEST_SEPOLIA_RPC_URL;
const privateKey = process.env.TEST_FAUCET_PRIVATE_KEY;
const skip = rpcUrl && privateKey ? false : 'TEST_SEPOLIA_RPC_URL or TEST_FAUCET_PRIVATE_KEY is not set';

test('a real 1 STK transfer on Sepolia is confirmed', { skip, timeout: 6 * 60 * 1000 }, async (t) => {
  const sender = createSender({ rpcUrl, privateKey, tokenAddress: '0x5595cb9ED193cAc2C0Bc5393313bc6115817954B', maxFeeWei: 100n * 10n ** 9n });
  t.after(() => sender.close());
  const unit = await sender.unit();
  const before = await sender.balances();
  assert.ok(before.token >= unit, 'the test wallet needs at least 1 STK');
  let stored = null;
  const result = await sender.send(sender.address, unit, async (hash) => { stored = hash; return true; });
  assert.equal(result.status, 'confirmed', JSON.stringify(result));
  assert.equal(result.hash, stored);
  assert.equal(await sender.receipt(result.hash), 'confirmed');
});
