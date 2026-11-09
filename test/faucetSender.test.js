const test = require('node:test');
const assert = require('node:assert/strict');
const { createSender, checkMaxFee } = require('../faucet/sender.js');

// A fake chain that records the order of the calls. Each method can be told to
// fail or to wait for the test.
function fakeChain() {
  const chain = {
    address: '0xFaucet',
    events: [],
    receiptStatus: 1, // 1 success, 0 revert, null = timeout
    signError: null,
    broadcastError: null,
    nonce: undefined, // a fake chain may omit the nonce
    known: true,
    decimalsCalls: 0,
    gate: null, // a promise that waitForReceipt awaits, if set
    async decimals() { chain.decimalsCalls += 1; return 18n; },
    async tokenBalance() { return 5n; },
    async ethBalance() { return 7n; },
    async signTransfer(to, amount) {
      chain.events.push(`sign ${to} ${amount}`);
      if (chain.signError) throw chain.signError;
      return { signed: `signed-${to}`, hash: `0xhash-${to}`, nonce: chain.nonce };
    },
    async broadcast(signed) {
      chain.events.push(`broadcast ${signed}`);
      if (chain.broadcastError) throw chain.broadcastError;
    },
    async waitForReceipt(hash) {
      chain.events.push(`wait ${hash}`);
      if (chain.gate) await chain.gate;
      return chain.receiptStatus === null ? null : { status: chain.receiptStatus };
    },
    async getReceipt() { return chain.receiptStatus === null ? null : { status: chain.receiptStatus }; },
    async knowsTransaction() { return chain.known; }
  };
  return chain;
}

const config = {};

test('the hash is stored before the broadcast, then the receipt is awaited', async () => {
  const chain = fakeChain();
  const sender = createSender(config, chain);
  const result = await sender.send('0xA', 10n, async (hash) => { chain.events.push(`stored ${hash}`); return true; });
  assert.deepEqual(result, { status: 'confirmed', hash: '0xhash-0xA' });
  assert.deepEqual(chain.events, ['sign 0xA 10', 'stored 0xhash-0xA', 'broadcast signed-0xA', 'wait 0xhash-0xA']);
});

test('the nonce of the signed transaction is stored with the hash', async () => {
  const chain = fakeChain();
  const sender = createSender(config, chain);
  chain.nonce = 42;
  const stored = [];
  await sender.send('0xA', 1n, async (hash, nonce) => { stored.push([hash, nonce]); return true; });
  chain.nonce = undefined;
  await sender.send('0xB', 1n, async (hash, nonce) => { stored.push([hash, nonce]); return true; });
  assert.deepEqual(stored, [['0xhash-0xA', 42], ['0xhash-0xB', null]]);
});

test('no broadcast when the hash cannot be stored', async () => {
  const chain = fakeChain();
  const sender = createSender(config, chain);
  assert.equal((await sender.send('0xA', 1n, async () => false)).status, 'aborted');
  const thrown = await sender.send('0xB', 1n, async () => { throw new Error('db down'); });
  assert.equal(thrown.status, 'aborted');
  assert.match(thrown.error, /db down/);
  assert.ok(!chain.events.some((e) => e.startsWith('broadcast')));
});

test('a revert is a failure, a timeout is pending', async () => {
  const chain = fakeChain();
  const sender = createSender(config, chain);
  chain.receiptStatus = 0;
  assert.deepEqual(await sender.send('0xA', 1n, async () => true), { status: 'failed', hash: '0xhash-0xA', error: 'transaction reverted' });
  chain.receiptStatus = null;
  assert.deepEqual(await sender.send('0xB', 1n, async () => true), { status: 'pending', hash: '0xhash-0xB' });
});

test('a signing error is a failure without a stored hash', async () => {
  const chain = fakeChain();
  chain.signError = new Error('insufficient balance for transfer');
  let stored = false;
  const result = await createSender(config, chain).send('0xA', 1n, async () => { stored = true; return true; });
  assert.equal(result.status, 'failed');
  assert.equal(result.hash, null);
  assert.equal(stored, false);
});

test('a broadcast error leaves the transfer pending, known or not', async () => {
  const chain = fakeChain();
  chain.broadcastError = new Error('connection reset');
  chain.known = false;
  const unknown = await createSender(config, chain).send('0xA', 1n, async () => true);
  assert.equal(unknown.status, 'pending');
  assert.equal(unknown.hash, '0xhash-0xA');
  assert.match(unknown.error, /connection reset/);
  chain.known = true;
  const known = await createSender(config, chain).send('0xB', 1n, async () => true);
  assert.equal(known.status, 'pending');
  assert.equal(known.hash, '0xhash-0xB');
  assert.match(known.error, /connection reset/);
});

test('a nonce refusal never frees the quota unless a receipt shows a revert', async () => {
  const nonceError = () => Object.assign(new Error('nonce has already been used'), { code: 'NONCE_EXPIRED' });
  // The RPC does not know the transaction: it can be behind, so the claim keeps counting.
  const unknown = fakeChain();
  unknown.broadcastError = nonceError();
  unknown.receiptStatus = null;
  unknown.known = false;
  const kept = await createSender(config, unknown).send('0xA', 1n, async () => true);
  assert.equal(kept.status, 'pending');
  assert.equal(kept.hash, '0xhash-0xA');
  assert.match(kept.error, /nonce has already been used/);
  // The same signed transaction reached the chain through another path and is mined.
  const mined = fakeChain();
  mined.broadcastError = nonceError();
  mined.receiptStatus = 1;
  assert.equal((await createSender(config, mined).send('0xB', 1n, async () => true)).status, 'confirmed');
  // It is mined and reverted: no STK moved.
  const reverted = fakeChain();
  reverted.broadcastError = nonceError();
  reverted.receiptStatus = 0;
  assert.deepEqual(await createSender(config, reverted).send('0xC', 1n, async () => true),
    { status: 'failed', hash: '0xhash-0xC', error: 'transaction reverted' });
  // It is known but not mined yet.
  const known = fakeChain();
  known.broadcastError = nonceError();
  known.receiptStatus = null;
  known.known = true;
  assert.equal((await createSender(config, known).send('0xD', 1n, async () => true)).status, 'pending');
  // A check that fails keeps the claim too.
  const receiptDown = fakeChain();
  receiptDown.broadcastError = nonceError();
  receiptDown.getReceipt = async () => { throw new Error('rpc down'); };
  assert.equal((await createSender(config, receiptDown).send('0xE', 1n, async () => true)).status, 'pending');
  const knowsDown = fakeChain();
  knowsDown.broadcastError = nonceError();
  knowsDown.receiptStatus = null;
  knowsDown.knowsTransaction = async () => { throw new Error('rpc down'); };
  assert.equal((await createSender(config, knowsDown).send('0xF', 1n, async () => true)).status, 'pending');
  // Any other broadcast error keeps the claim as before.
  const other = fakeChain();
  other.broadcastError = Object.assign(new Error('server error'), { code: 'SERVER_ERROR' });
  assert.equal((await createSender(config, other).send('0xG', 1n, async () => true)).status, 'pending');
});

test('transfers run one at a time', async () => {
  const chain = fakeChain();
  let release;
  chain.gate = new Promise((resolve) => { release = resolve; });
  const sender = createSender(config, chain);
  const first = sender.send('0xA', 1n, async () => true);
  const second = sender.send('0xB', 1n, async () => true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!chain.events.includes('sign 0xB 1'), chain.events.join(', '));
  release();
  await Promise.all([first, second]);
  assert.ok(chain.events.indexOf('sign 0xB 1') > chain.events.indexOf('wait 0xhash-0xA'));
});

test('a failed send does not block the queue', async () => {
  const chain = fakeChain();
  const sender = createSender(config, chain);
  await sender.send('0xA', 1n, async () => { throw new Error('x'); });
  assert.equal((await sender.send('0xB', 1n, async () => true)).status, 'confirmed');
});

test('receipt states', async () => {
  const chain = fakeChain();
  const sender = createSender(config, chain);
  chain.receiptStatus = 1;
  assert.equal(await sender.receipt('0x1'), 'confirmed');
  chain.receiptStatus = 0;
  assert.equal(await sender.receipt('0x1'), 'failed');
  chain.receiptStatus = null;
  chain.known = true;
  assert.equal(await sender.receipt('0x1'), 'pending');
  chain.known = false;
  assert.equal(await sender.receipt('0x1'), 'unknown');
});

test('the token unit is read once and balances come from the chain', async () => {
  const chain = fakeChain();
  const sender = createSender(config, chain);
  assert.equal(await sender.unit(), 10n ** 18n);
  assert.equal(await sender.unit(), 10n ** 18n);
  assert.equal(chain.decimalsCalls, 1);
  assert.deepEqual(await sender.balances(), { token: 5n, eth: 7n });
  assert.equal(sender.address, '0xFaucet');
});

test('close ends the chain connection, and a chain without destroy is fine', () => {
  const chain = fakeChain();
  let destroyed = 0;
  chain.destroy = () => { destroyed += 1; };
  createSender(config, chain).close();
  assert.equal(destroyed, 1);
  createSender(config, fakeChain()).close();
});

test('a gas price above the ceiling is refused before signing', () => {
  const max = 100n * 10n ** 9n;
  assert.doesNotThrow(() => checkMaxFee({ maxFeePerGas: max }, max));
  assert.doesNotThrow(() => checkMaxFee({ gasPrice: max }, max));
  assert.throws(() => checkMaxFee({ maxFeePerGas: max + 1n }, max), /gas price above FAUCET_MAX_FEE_GWEI \(100\.000000001 gwei\)/);
  assert.throws(() => checkMaxFee({ gasPrice: 2n * max }, max), /FAUCET_MAX_FEE_GWEI \(200\.0 gwei\)/);
});

test('a refused gas price is a failure without a stored hash', async () => {
  const chain = fakeChain();
  chain.signError = new Error('gas price above FAUCET_MAX_FEE_GWEI (150.0 gwei)');
  let stored = false;
  const result = await createSender(config, chain).send('0xA', 1n, async () => { stored = true; return true; });
  assert.deepEqual([result.status, result.hash, stored], ['failed', null, false]);
  assert.match(result.error, /FAUCET_MAX_FEE_GWEI/);
});
