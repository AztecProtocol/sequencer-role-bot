const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createEmptyDatabase } = require('./helpers/database.js');
const ledger = require('../faucet/ledger.js');
const recovery = require('../faucet/recovery.js');
const logger = require('../utils/logger.js');

// The error-path tests expect the logger to report failed alerts. Silence it
// for one test and restore it afterwards, so the test output stays clean.
function quietLogger(t) {
  const wasSilent = logger.silent;
  logger.silent = true;
  t.after(() => { logger.silent = wasSilent; });
}

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';
const UNIT = 10n ** 18n;
const HOUR = 3600000;
const T0 = new Date('2026-11-01T00:00:00Z');
const at = (hours) => new Date(T0.getTime() + hours * HOUR);
const LIMITS = { tier: 1, fixed: true, maxAmount: 1n * UNIT, step: UNIT, waitMs: 0, max30d: 10n ** 30n };

test('faucet recovery', { skip }, async (t) => {
  const pool = new Pool({ connectionString: await createEmptyDatabase(url, 'faucet_recovery_test') });
  t.after(() => pool.end());
  await require('../db/migrate.js').migrate(pool);
  const posts = [];
  const post = async (text) => { posts.push(text); };
  const clear = async () => { await pool.query('TRUNCATE faucet_claims, faucet_alerts RESTART IDENTITY'); posts.length = 0; };
  const claim = (user, now) => ledger.reserve(pool, {
    userId: user, wallet: '0x' + 'b'.repeat(40), limits: LIMITS, amount: UNIT, walletMax30d: 10n ** 30n, globalMax24h: 10n ** 30n, now
  });
  const statusOf = async (id) => (await pool.query('SELECT status FROM faucet_claims WHERE id = $1', [id])).rows[0].status;
  const receipts = new Map(); // hash -> 'confirmed' | 'failed' | 'pending' | 'unknown'
  const sender = { address: '0xfaucet', receipt: async (hash) => receipts.get(hash), balances: async () => sender.held };

  await t.test('each kind of alert is posted at most once in 24 hours', async () => {
    await clear();
    assert.equal(await recovery.alertOnce(pool, 'low_token', at(0), post, 'a'), true);
    assert.equal(await recovery.alertOnce(pool, 'low_token', at(23), post, 'b'), false);
    assert.equal(await recovery.alertOnce(pool, 'low_eth', at(23), post, 'c'), true);
    assert.equal(await recovery.alertOnce(pool, 'low_token', at(24), post, 'd'), true);
    assert.deepEqual(posts, ['a', 'c', 'd']);
  });

  await t.test('old rows are settled from their receipts, new rows are left alone', async () => {
    await clear();
    const reserved = await claim('u1', at(0));
    const confirmed = await claim('u2', at(0));
    const reverted = await claim('u3', at(0));
    const pending = await claim('u4', at(0));
    const lost = await claim('u5', at(0));
    for (const [row, hash, state] of [[confirmed, '0x1', 'confirmed'], [reverted, '0x2', 'failed'], [pending, '0x3', 'pending'], [lost, '0x4', 'unknown']]) {
      await ledger.markSent(pool, row.id, hash, at(0), 30 + row.id);
      receipts.set(hash, state);
    }
    const fresh = await claim('u6', at(1));

    const counts = await recovery.settleClaims({ pool, sender, post, now: at(1), minAgeMs: recovery.RECOVERY_AGE_MS });
    assert.deepEqual(counts, { failed: 2, confirmed: 1, pending: 1, unknown: 1 });
    assert.equal(await statusOf(reserved.id), 'failed');
    assert.equal(await statusOf(confirmed.id), 'confirmed');
    assert.equal(await statusOf(reverted.id), 'failed');
    assert.equal(await statusOf(pending.id), 'sent');
    assert.equal(await statusOf(lost.id), 'sent'); // unknown keeps counting
    assert.equal(await statusOf(fresh.id), 'reserved'); // younger than 30 minutes
    assert.equal(posts.length, 1);
    assert.match(posts[0], /0x4/);
    assert.match(posts[0], /unknown/);
    assert.match(posts[0], new RegExp(`nonce ${30 + lost.id}\\b`));
  });

  await t.test('an unknown transaction without a stored nonce says so', async () => {
    await clear();
    const row = await claim('u15', at(0));
    await ledger.markSent(pool, row.id, '0x9', at(0));
    receipts.set('0x9', 'unknown');
    await recovery.settleClaims({ pool, sender, post, now: at(1), minAgeMs: 0 });
    assert.match(posts[0], /nonce unknown/);
  });

  await t.test('at bot start every row is settled, whatever its age', async () => {
    await clear();
    const fresh = await claim('u7', at(1));
    await recovery.settleClaims({ pool, sender, post, now: at(1), minAgeMs: 0 });
    assert.equal(await statusOf(fresh.id), 'failed');
  });

  await t.test('a receipt read error leaves the row as it is', async () => {
    await clear();
    const row = await claim('u8', at(0));
    await ledger.markSent(pool, row.id, '0xbad', at(0));
    const broken = { ...sender, receipt: async () => { throw new Error('rpc down'); } };
    const counts = await recovery.settleClaims({ pool, sender: broken, post, now: at(2), minAgeMs: 0 });
    assert.equal(counts.pending, 1);
    assert.equal(await statusOf(row.id), 'sent');
  });

  await t.test('a reserved row that the bot sends during settling is not failed', async () => {
    await clear();
    const early = await claim('u12', at(0)); // lower id: the status job reaches it first
    const raced = await claim('u13', at(0));
    await ledger.markSent(pool, early.id, '0xearly', at(0));
    const racing = {
      ...sender,
      receipt: async () => {
        // The bot broadcasts the second claim while the status job waits for this receipt.
        await ledger.markSent(pool, raced.id, '0xraced', at(0));
        return 'pending';
      }
    };
    const counts = await recovery.settleClaims({ pool, sender: racing, post, now: at(1), minAgeMs: recovery.RECOVERY_AGE_MS });
    assert.equal(await statusOf(raced.id), 'sent');
    assert.deepEqual(counts, { failed: 0, confirmed: 0, pending: 1, unknown: 0 });
  });

  await t.test('a confirmed receipt for a row that moved on logs a warning', async (t2) => {
    await clear();
    const row = await claim('u14', at(0));
    await ledger.markSent(pool, row.id, '0xmoved', at(0));
    const warnings = [];
    const before = logger.warn;
    const wasSilent = logger.silent;
    logger.silent = true;
    logger.warn = (m) => warnings.push(m);
    t2.after(() => { logger.warn = before; logger.silent = wasSilent; });
    // The row is open in the snapshot; something else fails it while the receipt is read.
    const racing = {
      ...sender,
      receipt: async () => {
        await pool.query("UPDATE faucet_claims SET status = 'failed' WHERE id = $1", [row.id]);
        return 'confirmed';
      }
    };
    await recovery.settleClaims({ pool, sender: racing, post, now: at(1), minAgeMs: 0 });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`claim ${row.id}`));
  });

  await t.test('a low STK or ETH balance posts one alert per kind a day', async () => {
    await clear();
    const config = { alertMinToken: 2000000n, alertMinEthWei: 50000000000000000n };
    sender.held = { token: 1999999n * UNIT, eth: 10n ** 18n };
    await recovery.checkBalances({ pool, sender, config, unit: UNIT, post, now: at(0) });
    await recovery.checkBalances({ pool, sender, config, unit: UNIT, post, now: at(1) });
    assert.equal(posts.length, 1);
    assert.match(posts[0], /1999999 STK/);
    sender.held = { token: 3000000n * UNIT, eth: 10n ** 16n };
    await recovery.checkBalances({ pool, sender, config, unit: UNIT, post, now: at(2) });
    assert.equal(posts.length, 2);
    assert.match(posts[1], /0\.01 ETH/);
  });

  await t.test('a failed alert post frees its slot for the same moment', async (t2) => {
    quietLogger(t2);
    await clear();
    let fail = true;
    const flaky = async (text) => { if (fail) throw new Error('discord down'); posts.push(text); };
    await assert.rejects(recovery.alertOnce(pool, 'low_eth', at(0), flaky, 'x'), /discord down/);
    fail = false;
    assert.equal(await recovery.alertOnce(pool, 'low_eth', at(0), flaky, 'y'), true);
    assert.deepEqual(posts, ['y']);
  });

  await t.test('a failed unknown-tx alert does not stop settling other rows', async (t2) => {
    quietLogger(t2);
    await clear();
    const first = await claim('u9', at(0));
    const second = await claim('u10', at(0));
    const reserved = await claim('u11', at(0));
    await ledger.markSent(pool, first.id, '0x7', at(0));
    await ledger.markSent(pool, second.id, '0x8', at(0));
    receipts.set('0x7', 'unknown');
    receipts.set('0x8', 'unknown');
    const broken = async () => { throw new Error('discord down'); };
    const counts = await recovery.settleClaims({ pool, sender, post: broken, now: at(1), minAgeMs: recovery.RECOVERY_AGE_MS });
    assert.equal(counts.unknown, 2);
    assert.equal(await statusOf(reserved.id), 'failed');
  });

  await t.test('a failed low-balance post does not stop the other alert', async (t2) => {
    quietLogger(t2);
    await clear();
    const config = { alertMinToken: 2000000n, alertMinEthWei: 50000000000000000n };
    sender.held = { token: 1999999n * UNIT, eth: 10n ** 16n };
    let calls = 0;
    const onlyFirstFails = async (text) => {
      calls += 1;
      if (calls === 1) throw new Error('discord down');
      posts.push(text);
    };
    await recovery.checkBalances({ pool, sender, config, unit: UNIT, post: onlyFirstFails, now: at(0) });
    assert.equal(calls, 2);
    assert.equal(posts.length, 1);
    assert.match(posts[0], /0\.01 ETH/);
  });
});
