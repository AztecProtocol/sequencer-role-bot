const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeProviderChain } = require('./helpers/providerChain.js');
const { eligibleSignerKind, providerExists } = require('../providers/signers.js');

const ADMIN = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const OWNER = '0x3333333333333333333333333333333333333333';
const OTHER = '0x4444444444444444444444444444444444444444';
const SAFE = '0x5555555555555555555555555555555555555555';

test('the admin key of a provider is an eligible signer', async () => {
  const chain = fakeProviderChain();
  chain.setProvider(5, ADMIN, RECIPIENT);
  assert.equal(await eligibleSignerKind(chain, 5, ADMIN), 'admin');
});

test('the rewards recipient key of a provider is an eligible signer', async () => {
  const chain = fakeProviderChain();
  chain.setProvider(5, ADMIN, RECIPIENT);
  assert.equal(await eligibleSignerKind(chain, 5, RECIPIENT), 'recipient');
});

test('an address is matched without regard to letter case', async () => {
  const chain = fakeProviderChain();
  chain.setProvider(5, '0xAbCdEf0000000000000000000000000000000001', RECIPIENT);
  assert.equal(await eligibleSignerKind(chain, 5, '0xabcdef0000000000000000000000000000000001'), 'admin');
});

test('a key with EIP-7702 code is treated as a plain key', async () => {
  const chain = fakeProviderChain();
  chain.setProvider(5, ADMIN, RECIPIENT);
  chain.setCode(ADMIN, '0xef0100' + 'ab'.repeat(20));
  assert.equal(await eligibleSignerKind(chain, 5, ADMIN), 'admin');
});

test('an owner of a Safe admin is an eligible signer', async () => {
  const chain = fakeProviderChain();
  chain.setProvider(5, SAFE, RECIPIENT);
  chain.setSafe(SAFE, [OWNER, OTHER]);
  assert.equal(await eligibleSignerKind(chain, 5, OWNER), 'admin_safe_owner');
});

test('an owner of a Safe rewards recipient is an eligible signer', async () => {
  const chain = fakeProviderChain();
  chain.setProvider(5, ADMIN, SAFE);
  chain.setSafe(SAFE, [OWNER]);
  assert.equal(await eligibleSignerKind(chain, 5, OWNER), 'recipient_safe_owner');
});

test('the Safe address itself is not an eligible signer', async () => {
  const chain = fakeProviderChain();
  chain.setProvider(5, SAFE, RECIPIENT);
  chain.setSafe(SAFE, [OWNER]);
  assert.equal(await eligibleSignerKind(chain, 5, SAFE), null);
});

test('an address with no role in the provider is not an eligible signer', async () => {
  const chain = fakeProviderChain();
  chain.setProvider(5, ADMIN, RECIPIENT);
  assert.equal(await eligibleSignerKind(chain, 5, OTHER), null);
});

test('a contract that is not a Safe gives no eligible signer', async () => {
  const chain = fakeProviderChain();
  chain.setProvider(5, ADMIN, RECIPIENT);
  chain.setCode(RECIPIENT, '0x6080604052');
  assert.equal(await eligibleSignerKind(chain, 5, RECIPIENT), null);
});

test('a provider id that is not in use has no eligible signer and does not exist', async () => {
  const chain = fakeProviderChain();
  assert.equal(await eligibleSignerKind(chain, 99, ADMIN), null);
  assert.equal(await providerExists(chain, 99), false);
});

test('a provider id in use exists', async () => {
  const chain = fakeProviderChain();
  chain.setProvider(5, ADMIN, RECIPIENT);
  assert.equal(await providerExists(chain, 5), true);
});
