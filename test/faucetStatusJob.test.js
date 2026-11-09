const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadBot } = require('./helpers/discordHarness.js');
const logger = require('../utils/logger.js');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';
const UNIT = 10n ** 18n;

test('the status job settles old faucet claims and checks the wallet', { skip }, async () => {
  const fake = {
    address: '0x' + 'f'.repeat(40),
    held: { token: 10n ** 30n, eth: 10n ** 18n },
    unit: async () => UNIT,
    balances: async () => fake.held,
    receipt: async () => 'confirmed',
    send: async () => { throw new Error('the status job must not send'); },
    closed: 0,
    close: () => { fake.closed += 1; }
  };
  require(path.join(__dirname, '..', 'faucet', 'sender.js')).createSender = () => fake;
  Object.assign(process.env, {
    FAUCET_ENABLED: 'true',
    FAUCET_CHANNEL_ID: '444',
    FAUCET_VERIFIED_ROLE_ID: '555',
    FAUCET_PRIVATE_KEY: '0x' + '11'.repeat(32),
    AZTEC_RPC_URL: 'http://sepolia.invalid'
  });
  const h = await loadBot(url, 'faucet_status_job_test');
  await h.reset();

  const insert = (status, hash, minutesAgo) => h.pool.query(
    `INSERT INTO faucet_claims (discord_user_id, wallet_address, tier, amount, status, tx_hash, created_at, updated_at)
     VALUES ('1', '0xabc', 1, 1, $1, $2, NOW() - make_interval(mins => $3::int), NOW() - make_interval(mins => $3::int)) RETURNING id`,
    [status, hash, minutesAgo]
  ).then((r) => r.rows[0].id);
  const oldSent = await insert('sent', '0x1', 60);
  const queued = await insert('reserved', null, 5);
  const statusOf = async (id) => (await h.pool.query('SELECT status FROM faucet_claims WHERE id = $1', [id])).rows[0].status;

  await h.job.runFaucetCheck();
  assert.equal(await statusOf(oldSent), 'confirmed');
  assert.equal(fake.closed, 1); // the RPC connection is closed after each run
  assert.equal(await statusOf(queued), 'reserved'); // still in the bot's queue

  fake.held = { token: 1n * UNIT, eth: 10n ** 18n };
  await h.job.runFaucetCheck();
  await h.job.runFaucetCheck();
  assert.equal(h.adminMessages.filter((m) => m.includes('STK')).length, 1);

  // An alert that cannot be posted frees its slot, so the next run posts it.
  await h.pool.query('TRUNCATE faucet_alerts');
  h.adminMessages.length = 0;
  const realFetch = h.clients.map((c) => c.channels.fetch);
  const wasSilent = logger.silent;
  logger.silent = true;
  try {
    for (const c of h.clients) c.channels.fetch = async () => ({ send: async () => { throw new Error('discord down'); } });
    await h.job.runFaucetCheck();
    assert.equal((await h.pool.query('SELECT 1 FROM faucet_alerts')).rowCount, 0);
  } finally {
    h.clients.forEach((c, i) => { c.channels.fetch = realFetch[i]; });
    logger.silent = wasSilent;
  }
  await h.job.runFaucetCheck();
  assert.equal(h.adminMessages.filter((m) => m.includes('STK')).length, 1);

  // Admin posts never ping anyone: the alert and the plain log line.
  const payloads = [];
  const recordFetch = h.clients.map((c) => c.channels.fetch);
  for (const c of h.clients) c.channels.fetch = async () => ({ send: async (payload) => { payloads.push(payload); } });
  try {
    await h.pool.query('TRUNCATE faucet_alerts');
    await h.job.runFaucetCheck();
    await h.job.logToAdminChannel('@everyone test');
  } finally {
    h.clients.forEach((c, i) => { c.channels.fetch = recordFetch[i]; });
  }
  assert.equal(payloads.length, 2);
  for (const payload of payloads) assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.match(payloads[1].content, /\] @everyone test$/);
});
