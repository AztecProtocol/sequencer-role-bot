const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createEmptyDatabase } = require('./helpers/database.js');
const ledger = require('../faucet/ledger.js');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';

const UNIT = 10n ** 18n;
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-01T00:00:00Z');
const at = (days) => new Date(T0.getTime() + days * DAY);
const config = {
  member: { amount: 200000n, waitHours: 2160, max30d: 200000n },
  operator: { amount: 200000n, waitHours: 168, max30d: 400000n }
};
const TIER1 = ledger.tierLimits(config, 1, UNIT);
const TIER2 = ledger.tierLimits(config, 2, UNIT);
// A hand-made variable-amount limit set: the ledger still supports it, and it
// lets the free-at date tests use different amounts.
const VAR = { tier: 2, fixed: false, maxAmount: 1000000n * UNIT, step: UNIT, waitMs: 24 * 3600000, max30d: 2000000n * UNIT };
const BIG = 10n ** 40n; // a limit that never binds
const W = '0x' + 'a'.repeat(40);

test('faucet ledger', { skip }, async (t) => {
  const pool = new Pool({ connectionString: await createEmptyDatabase(url, 'faucet_ledger_test') });
  t.after(() => pool.end());
  await require('../db/migrate.js').migrate(pool);
  const clear = () => pool.query('TRUNCATE faucet_claims RESTART IDENTITY');
  const reserve = (userId, limits, amount, now, extra = {}) => ledger.reserve(pool, {
    userId, wallet: extra.wallet || W, limits, amount, now,
    walletMax30d: extra.walletMax30d || BIG, globalMax24h: extra.globalMax24h || BIG
  });

  await t.test('tier limits are in base units', () => {
    assert.deepEqual(TIER1, { tier: 1, fixed: true, maxAmount: 200000n * UNIT, step: UNIT, waitMs: 2160 * 3600000, max30d: 200000n * UNIT });
    assert.deepEqual(TIER2, { tier: 2, fixed: true, maxAmount: 200000n * UNIT, step: UNIT, waitMs: 168 * 3600000, max30d: 400000n * UNIT });
  });

  await t.test('an amount that the limits do not allow is a programming error', async () => {
    await clear();
    await assert.rejects(reserve('u1', TIER2, 0n, at(0)), /amount/);
    await assert.rejects(reserve('u1', TIER2, -1n, at(0)), /amount/);
    await assert.rejects(reserve('u1', TIER2, TIER2.maxAmount + 1n, at(0)), /amount/);
    await assert.rejects(reserve('u1', TIER2, TIER2.maxAmount - 1n, at(0)), /amount/); // fixed amount
    await assert.rejects(reserve('u1', TIER1, TIER1.maxAmount - 1n, at(0)), /amount/);
    assert.equal((await pool.query('SELECT 1 FROM faucet_claims')).rowCount, 0);
  });

  await t.test('the member rule: one claim, then 90 days of wait', async () => {
    await clear();
    assert.equal((await reserve('u1', TIER1, TIER1.maxAmount, at(0))).ok, true);
    assert.deepEqual(await reserve('u1', TIER1, TIER1.maxAmount, at(89)), { ok: false, reason: 'wait', until: at(90) });
    assert.equal((await reserve('u1', TIER1, TIER1.maxAmount, at(90))).ok, true);
  });

  await t.test('the operator rule: 7 days of wait and two claims in 30 days', async () => {
    await clear();
    assert.equal((await reserve('u1', TIER2, TIER2.maxAmount, at(0))).ok, true);
    assert.deepEqual(await reserve('u1', TIER2, TIER2.maxAmount, at(6)), { ok: false, reason: 'wait', until: at(7) });
    assert.equal((await reserve('u1', TIER2, TIER2.maxAmount, at(7))).ok, true);
    assert.deepEqual(await reserve('u1', TIER2, TIER2.maxAmount, at(14)), { ok: false, reason: 'user_30d', until: at(30) });
    assert.equal((await reserve('u1', TIER2, TIER2.maxAmount, at(30.001))).ok, true);
  });

  await t.test('the pre-form check gives the remaining 30-day amount', async () => {
    await clear();
    await reserve('u2', VAR, 700000n * UNIT, at(0));
    assert.deepEqual(await ledger.nextClaimCheck(pool, { userId: 'u2', limits: VAR, now: at(0.5) }),
      { ok: false, reason: 'wait', until: at(1) });
    assert.deepEqual(await ledger.nextClaimCheck(pool, { userId: 'u2', limits: VAR, now: at(1) }),
      { ok: true, remaining: 1300000n * UNIT });
  });

  await t.test('a failed claim does not count', async () => {
    await clear();
    const first = await reserve('u3', TIER1, TIER1.maxAmount, at(0));
    assert.equal(await ledger.markFailed(pool, first.id, 'reverted', at(0)), true);
    assert.equal((await reserve('u3', TIER1, TIER1.maxAmount, at(0))).ok, true);
  });

  await t.test('one wallet gets at most its 30-day amount from all accounts together', async () => {
    await clear();
    const walletMax30d = 2000000n * UNIT;
    assert.equal((await reserve('a', VAR, 1000000n * UNIT, at(0), { walletMax30d })).ok, true);
    assert.equal((await reserve('b', VAR, 1000000n * UNIT, at(0), { walletMax30d })).ok, true);
    const third = await reserve('c', TIER2, TIER2.maxAmount, at(1), { walletMax30d, wallet: W.toUpperCase().replace('0X', '0x') });
    assert.deepEqual(third, { ok: false, reason: 'wallet_30d', until: at(30) });
  });

  await t.test('the claim-again date is when enough quota frees, not the oldest claim', async () => {
    await clear();
    const LOOSE2 = { ...VAR, waitMs: 0 };
    const w = (n) => '0x' + String(n).repeat(40);
    await reserve('m1', LOOSE2, 500000n * UNIT, at(0), { wallet: w(4) });
    await reserve('m1', LOOSE2, 1000000n * UNIT, at(1), { wallet: w(5) });
    await reserve('m1', LOOSE2, 400000n * UNIT, at(1.5), { wallet: w(6) });
    // used 1.9M of 2M; 1M more needs 0.9M freed: the day-0 claim (0.5M) is not enough.
    assert.deepEqual(await reserve('m1', LOOSE2, 1000000n * UNIT, at(2), { wallet: w(7) }),
      { ok: false, reason: 'user_30d', until: at(31) });
    // 0.6M more needs 0.5M freed: the day-0 claim is enough.
    assert.deepEqual(await reserve('m1', LOOSE2, 600000n * UNIT, at(2), { wallet: w(7) }),
      { ok: false, reason: 'user_30d', until: at(30) });
    // The pre-form check uses the same rule.
    const early = await ledger.nextClaimCheck(pool, { userId: 'm1', limits: { ...LOOSE2, step: 200000n * UNIT }, now: at(2) });
    assert.deepEqual(early, { ok: false, reason: 'user_30d', until: at(30) });

    // Wallet limit: the wallet holds 0.5M (day 0) and 1M (day 2) of 1.9M; 1M more needs 0.6M freed.
    const walletMax30d = 1900000n * UNIT;
    assert.equal((await reserve('m2', LOOSE2, 1000000n * UNIT, at(2), { walletMax30d, wallet: w(4) })).ok, true);
    assert.deepEqual(await reserve('m3', LOOSE2, 1000000n * UNIT, at(3), { walletMax30d, wallet: w(4) }),
      { ok: false, reason: 'wallet_30d', until: at(32) });
  });

  await t.test('the daily-cap date is when enough of the last 24 hours frees', async () => {
    await clear();
    const LOOSE2 = { ...VAR, waitMs: 0 };
    const globalMax24h = 2000000n * UNIT;
    await reserve('g1', LOOSE2, 300000n * UNIT, at(0), { globalMax24h, wallet: '0x' + '1'.repeat(40) });
    await reserve('g2', LOOSE2, 1000000n * UNIT, at(0.5), { globalMax24h, wallet: '0x' + '2'.repeat(40) });
    await reserve('g3', LOOSE2, 600000n * UNIT, at(0.55), { globalMax24h, wallet: '0x' + '3'.repeat(40) });
    // used 1.9M of 2M; 1M more needs 0.9M freed: the claims of day 0 and day 0.5.
    assert.deepEqual(await reserve('g4', LOOSE2, 1000000n * UNIT, at(0.6), { globalMax24h, wallet: '0x' + '4'.repeat(40) }),
      { ok: false, reason: 'global_24h', until: at(1.5) });
  });

  await t.test('the global cap counts every claim in the last 24 hours', async () => {
    await clear();
    const globalMax24h = 400000n * UNIT;
    await reserve('a', TIER1, TIER1.maxAmount, at(0), { globalMax24h, wallet: '0x' + '1'.repeat(40) });
    await reserve('b', TIER1, TIER1.maxAmount, at(0.5), { globalMax24h, wallet: '0x' + '2'.repeat(40) });
    const full = await reserve('c', TIER1, TIER1.maxAmount, at(0.9), { globalMax24h, wallet: '0x' + '3'.repeat(40) });
    assert.deepEqual(full, { ok: false, reason: 'global_24h', until: at(1) });
    assert.equal((await reserve('c', TIER1, TIER1.maxAmount, at(1.001), { globalMax24h, wallet: '0x' + '3'.repeat(40) })).ok, true);
  });

  await t.test('20 parallel requests against a cap of 5 claims: exactly 5 pass', async () => {
    await clear();
    const globalMax24h = 5n * TIER1.maxAmount;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      reserve(`p${i}`, TIER1, TIER1.maxAmount, at(0), { globalMax24h, wallet: '0x' + i.toString(16).padStart(40, '0') })));
    assert.equal(results.filter((r) => r.ok).length, 5);
    assert.equal(results.filter((r) => r.reason === 'global_24h').length, 15);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM faucet_claims');
    assert.equal(rows[0].n, 5);
  });

  await t.test('status changes only move forward', async () => {
    await clear();
    const { id } = await reserve('s', TIER1, TIER1.maxAmount, at(0));
    assert.equal(await ledger.markConfirmed(pool, id, at(0)), false); // not sent yet
    assert.equal(await ledger.markSent(pool, id, '0xabc', at(0)), true);
    assert.equal(await ledger.markSent(pool, id, '0xdef', at(0)), false); // already sent
    assert.equal(await ledger.markConfirmed(pool, id, at(0)), true);
    assert.equal(await ledger.markFailed(pool, id, 'late', at(0)), false); // confirmed stays

    const other = await reserve('s2', TIER1, TIER1.maxAmount, at(0));
    await ledger.markFailed(pool, other.id, 'cleaned', at(0));
    assert.equal(await ledger.markSent(pool, other.id, '0x123', at(0)), false); // failed is final
  });

  await t.test('the nonce is stored with the hash', async () => {
    await clear();
    const { id } = await reserve('n1', TIER1, TIER1.maxAmount, at(0));
    assert.equal(await ledger.markSent(pool, id, '0xabc', at(0), 7), true);
    const rows = await ledger.rowsToSettle(pool, at(1));
    assert.deepEqual(rows.map((r) => [r.id, r.tx_hash, String(r.nonce)]), [[id, '0xabc', '7']]);
  });

  await t.test('rows to settle are reserved or sent rows not updated since the given time', async () => {
    await clear();
    const old = await reserve('r1', TIER1, TIER1.maxAmount, at(0));
    const sent = await reserve('r2', TIER1, TIER1.maxAmount, at(0));
    await ledger.markSent(pool, sent.id, '0xfeed', at(0));
    const fresh = await reserve('r3', TIER1, TIER1.maxAmount, at(1));
    const done = await reserve('r4', TIER1, TIER1.maxAmount, at(0));
    await ledger.markSent(pool, done.id, '0xbeef', at(0));
    await ledger.markConfirmed(pool, done.id, at(0));
    const rows = await ledger.rowsToSettle(pool, at(0.5));
    assert.deepEqual(rows.map((r) => [r.id, r.status, r.tx_hash, r.nonce]), [[old.id, 'reserved', null, null], [sent.id, 'sent', '0xfeed', null]]);
    assert.ok(!rows.some((r) => r.id === fresh.id));
  });

  const confirmed = async (userId, limits, now, extra = {}) => {
    const r = await reserve(userId, limits, limits.maxAmount, now, extra);
    assert.equal(r.ok, true);
    await ledger.markSent(pool, r.id, '0x' + String(r.id).padStart(64, '0'), now, 1);
    await ledger.markConfirmed(pool, r.id, now);
    return r.id;
  };

  await t.test('a staff reset waives the confirmed claims and the wait no longer binds', async () => {
    await clear();
    const id = await confirmed('w1', TIER1, at(0));
    assert.equal((await reserve('w1', TIER1, TIER1.maxAmount, at(1))).reason, 'wait');
    const result = await ledger.waiveClaims(pool, { userId: 'w1', staffId: 'staff1', now: at(1) });
    assert.deepEqual(result, { ok: true, waived: [{ id, createdAt: at(0), amount: TIER1.maxAmount }] });
    const { rows } = await pool.query('SELECT waived_by, waived_at FROM faucet_claims WHERE id = $1', [id]);
    assert.equal(rows[0].waived_by, 'staff1');
    assert.deepEqual(rows[0].waived_at, at(1));
    assert.equal((await reserve('w1', TIER1, TIER1.maxAmount, at(1))).ok, true);
  });

  await t.test('a waived claim still counts for the wallet cap', async () => {
    await clear();
    const walletMax30d = 400000n * UNIT;
    await confirmed('wa', TIER1, at(0));
    await ledger.waiveClaims(pool, { userId: 'wa', staffId: 's', now: at(0.5) });
    assert.equal((await reserve('wa', TIER1, TIER1.maxAmount, at(1), { walletMax30d })).ok, true);
    assert.equal((await reserve('wb', TIER1, TIER1.maxAmount, at(1), { walletMax30d })).reason, 'wallet_30d');
  });

  await t.test('a waived claim still counts for the global cap', async () => {
    await clear();
    const globalMax24h = 200000n * UNIT;
    await confirmed('ga', TIER1, at(0), { globalMax24h });
    await ledger.waiveClaims(pool, { userId: 'ga', staffId: 's', now: at(0.2) });
    const other = await reserve('gb', TIER1, TIER1.maxAmount, at(0.5), { globalMax24h, wallet: '0x' + '2'.repeat(40) });
    assert.equal(other.reason, 'global_24h');
  });

  await t.test('an open claim blocks the reset and nothing is waived', async () => {
    await clear();
    await confirmed('o1', TIER2, at(0));
    const reservedRow = await reserve('o1', TIER2, TIER2.maxAmount, at(8));
    assert.deepEqual(await ledger.waiveClaims(pool, { userId: 'o1', staffId: 's', now: at(9) }),
      { ok: false, reason: 'open_claim', claim: { id: reservedRow.id, status: 'reserved', nonce: null } });
    await ledger.markSent(pool, reservedRow.id, '0xabc', at(8), 7);
    assert.deepEqual(await ledger.waiveClaims(pool, { userId: 'o1', staffId: 's', now: at(9) }),
      { ok: false, reason: 'open_claim', claim: { id: reservedRow.id, status: 'sent', nonce: 7 } });
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM faucet_claims WHERE waived_at IS NOT NULL');
    assert.equal(rows[0].n, 0);
  });

  await t.test('with nothing to waive the reset returns an empty list, also the second time', async () => {
    await clear();
    assert.deepEqual(await ledger.waiveClaims(pool, { userId: 'e1', staffId: 's', now: at(0) }), { ok: true, waived: [] });
    await confirmed('e1', TIER1, at(0));
    assert.equal((await ledger.waiveClaims(pool, { userId: 'e1', staffId: 's', now: at(1) })).waived.length, 1);
    assert.deepEqual(await ledger.waiveClaims(pool, { userId: 'e1', staffId: 's', now: at(2) }), { ok: true, waived: [] });
  });
  await t.test('a member who becomes an operator can claim after the operator wait', async () => {
    await clear();
    assert.equal((await reserve('r1', TIER1, TIER1.maxAmount, at(0))).ok, true);
    assert.equal((await reserve('r1', TIER2, TIER2.maxAmount, at(7))).ok, true);
  });

  await t.test('an operator who loses the role follows the member wait from the last claim', async () => {
    await clear();
    assert.equal((await reserve('r2', TIER2, TIER2.maxAmount, at(0))).ok, true);
    assert.equal((await reserve('r2', TIER2, TIER2.maxAmount, at(7))).ok, true);
    assert.deepEqual(await reserve('r2', TIER1, TIER1.maxAmount, at(30)), { ok: false, reason: 'wait', until: at(97) });
    assert.equal((await reserve('r2', TIER1, TIER1.maxAmount, at(97))).ok, true);
  });

  await t.test('an operator at the 30-day maximum can claim again after a reset', async () => {
    await clear();
    assert.equal((await reserve('r3', TIER2, TIER2.maxAmount, at(0))).ok, true);
    assert.equal((await reserve('r3', TIER2, TIER2.maxAmount, at(7))).ok, true);
    assert.equal((await reserve('r3', TIER2, TIER2.maxAmount, at(14))).reason, 'user_30d');
    // The rows must be confirmed for the reset.
    await pool.query("UPDATE faucet_claims SET status = 'confirmed' WHERE discord_user_id = 'r3'");
    await ledger.waiveClaims(pool, { userId: 'r3', staffId: 's', now: at(14) });
    assert.equal((await reserve('r3', TIER2, TIER2.maxAmount, at(14))).ok, true);
  });

  await t.test('a reset skips failed rows, leaves other users alone and changes no status', async () => {
    await clear();
    await confirmed('s1', TIER1, at(0));
    const failed = await reserve('s1', TIER2, TIER2.maxAmount, at(8));
    await ledger.markFailed(pool, failed.id, 'x', at(8));
    await confirmed('s2', TIER1, at(0), { wallet: '0x' + '3'.repeat(40) });
    const result = await ledger.waiveClaims(pool, { userId: 's1', staffId: 's', now: at(9) });
    assert.equal(result.waived.length, 1);
    const { rows } = await pool.query('SELECT discord_user_id, status, waived_at FROM faucet_claims ORDER BY id');
    assert.deepEqual(rows.map((r) => [r.discord_user_id, r.status, r.waived_at !== null]),
      [['s1', 'confirmed', true], ['s1', 'failed', false], ['s2', 'confirmed', false]]);
  });

  await t.test('the reset reason is stored on every waived row, cut to 200 characters', async () => {
    await clear();
    await confirmed('q1', TIER2, at(0));
    await confirmed('q1', TIER2, at(8));
    await ledger.waiveClaims(pool, { userId: 'q1', staffId: 's', now: at(9), reason: ' slashed ' });
    let rows = (await pool.query('SELECT waived_reason FROM faucet_claims ORDER BY id')).rows;
    assert.deepEqual(rows.map((r) => r.waived_reason), ['slashed', 'slashed']);
    await clear();
    await confirmed('q2', TIER1, at(0));
    await ledger.waiveClaims(pool, { userId: 'q2', staffId: 's', now: at(1), reason: 'x'.repeat(300) });
    rows = (await pool.query('SELECT waived_reason FROM faucet_claims')).rows;
    assert.equal(rows[0].waived_reason, 'x'.repeat(200));
    await clear();
    await confirmed('q3', TIER1, at(0));
    await ledger.waiveClaims(pool, { userId: 'q3', staffId: 's', now: at(1) });
    assert.equal((await pool.query('SELECT waived_reason FROM faucet_claims')).rows[0].waived_reason, null);
  });
});
