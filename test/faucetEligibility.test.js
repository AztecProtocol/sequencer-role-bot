const test = require('node:test');
const assert = require('node:assert/strict');
const { accountCreatedAt, memberFacts, checkEligibility } = require('../faucet/eligibility.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-10T12:00:00Z');
const VERIFIED = '555';
const config = {
  enabled: true, channelId: '444', verifiedRoleId: VERIFIED, testnetRoleId: '111',
  minAccountDays: 90, minServerDays: 7
};
// A snowflake whose embedded time is `ms`.
const snowflakeAt = (ms) => String((BigInt(ms) - 1420070400000n) << 22n);

function facts({ accountDays = 400, serverDays = 30, roles = [VERIFIED], timeoutUntil = null, flags = 0, channelId = '444' } = {}) {
  return memberFacts({
    user: { id: snowflakeAt(NOW.getTime() - accountDays * DAY) },
    channelId,
    member: {
      roles: { cache: { has: (id) => roles.includes(id) } },
      joinedAt: new Date(NOW.getTime() - serverDays * DAY),
      communicationDisabledUntil: timeoutUntil,
      flags: { bitfield: flags }
    }
  });
}

test('the creation time is read from the user id', () => {
  // A known id: 175928847299117063 was created 2016-04-30T11:18:25.796Z (Discord docs example).
  assert.equal(accountCreatedAt('175928847299117063').toISOString(), '2016-04-30T11:18:25.796Z');
});

test('a verified member in good standing follows the member rule', () => {
  assert.deepEqual(checkEligibility(facts(), config, NOW), { ok: true, tier: 1 });
});

test('the testnet sequencer role gives the operator rule, the mainnet role alone does not', () => {
  assert.deepEqual(checkEligibility(facts({ roles: [VERIFIED, '111'] }), config, NOW), { ok: true, tier: 2 });
  assert.deepEqual(checkEligibility(facts({ roles: [VERIFIED, '222'] }), config, NOW), { ok: true, tier: 1 });
});

test('a sequencer role without the verified role is refused', () => {
  assert.equal(checkEligibility(facts({ roles: ['111'] }), config, NOW).reason, 'not_verified');
});

test('the faucet off comes first, then the channel', () => {
  assert.deepEqual(checkEligibility(facts(), { enabled: false }, NOW), { ok: false, reason: 'disabled' });
  assert.deepEqual(checkEligibility(facts({ channelId: '999' }), config, NOW), { ok: false, reason: 'wrong_channel' });
});

test('the account age limit is inclusive at 90 days', () => {
  const young = checkEligibility(facts({ accountDays: 89 }), config, NOW);
  assert.equal(young.reason, 'account_too_new');
  assert.equal(young.until.getTime(), NOW.getTime() + DAY);
  assert.equal(checkEligibility(facts({ accountDays: 90 }), config, NOW).ok, true);
});

test('the server age limit is inclusive at 7 days', () => {
  const recent = checkEligibility(facts({ serverDays: 6 }), config, NOW);
  assert.equal(recent.reason, 'server_too_new');
  assert.equal(recent.until.getTime(), NOW.getTime() + DAY);
  assert.equal(checkEligibility(facts({ serverDays: 7 }), config, NOW).ok, true);
});

test('a member without a join date is refused without a date', () => {
  const f = facts();
  f.joinedAt = null;
  assert.deepEqual(checkEligibility(f, config, NOW), { ok: false, reason: 'server_too_new', until: null });
});

test('a running timeout is refused, an ended timeout is not', () => {
  const end = new Date(NOW.getTime() + 3600000);
  assert.deepEqual(checkEligibility(facts({ timeoutUntil: end }), config, NOW), { ok: false, reason: 'timed_out', until: end });
  assert.equal(checkEligibility(facts({ timeoutUntil: new Date(NOW.getTime() - 1) }), config, NOW).ok, true);
});

test('both AutoMod quarantine flags are refused, other flags are not', () => {
  assert.equal(checkEligibility(facts({ flags: 128 }), config, NOW).reason, 'quarantined');
  assert.equal(checkEligibility(facts({ flags: 1024 }), config, NOW).reason, 'quarantined');
  assert.equal(checkEligibility(facts({ flags: 1 | 2 }), config, NOW).ok, true);
});

test('member flags given as a plain number are read too', () => {
  const f = memberFacts({ user: { id: '1' }, channelId: '444', member: { flags: 128, roles: { cache: { has: () => false } } } });
  assert.equal(f.flags, 128);
  assert.equal(f.hasRole(''), false);
});
