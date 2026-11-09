const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadBot } = require('./helpers/discordHarness.js');
const { ethers } = require('ethers');
const { MessageFlags } = require('discord.js');
const { createFaucet, waitText } = require('../faucet/flow.js');
const { loadFaucetConfig } = require('../faucet/config.js');
const logger = require('../utils/logger.js');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';

const UNIT = 10n ** 18n;
const DAY = 24 * 60 * 60 * 1000;
const FAUCET_CHANNEL = '444';
const VERIFIED = '555';
const FAUCET_WALLET = '0x' + 'f'.repeat(40);
const snowflakeAt = (ms, n) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));

// A member, as the interaction carries it.
function person(n, { accountDays = 400, serverDays = 30, roles = [VERIFIED], timeoutUntil = null, flags = 0, channelId = FAUCET_CHANNEL } = {}) {
  const user = { id: snowflakeAt(Date.now() - accountDays * DAY, n), username: `member${n}` };
  const member = {
    roles: { cache: { has: (id) => roles.includes(id) } },
    joinedAt: new Date(Date.now() - serverDays * DAY),
    communicationDisabledUntil: timeoutUntil,
    flags: { bitfield: flags }
  };
  return { user, extra: { member, channelId } };
}

test('the panel names a wait time in days or hours', () => {
  assert.equal(waitText(168), '7 days');
  assert.equal(waitText(24), '1 day');
  assert.equal(waitText(36), '36 hours');
  assert.equal(waitText(12), '12 hours');
});

test('faucet flow in the bot', { skip }, async (t) => {
  // The chain boundary: a fake sender, put in before bot.js loads.
  const fake = {
    address: FAUCET_WALLET,
    outcome: 'confirmed',
    throwOnSend: false,
    throwAfterSigned: false,
    pendingError: null,
    sent: [],
    unit: async () => UNIT,
    balances: async () => ({ token: 10n ** 30n, eth: 10n ** 18n }),
    async send(to, amount, onSigned) {
      const hash = '0x' + (fake.sent.length + 1).toString(16).padStart(64, '0');
      if (fake.throwOnSend) throw new Error('rpc down');
      fake.sent.push({ to, amount });
      if ((await onSigned(hash)) === false) return { status: 'aborted', hash };
      if (fake.throwAfterSigned) throw new Error('receipt read failed');
      if (fake.outcome === 'aborted') return { status: 'aborted', hash };
      if (fake.outcome === 'failed') return { status: 'failed', hash, error: 'transaction reverted' };
      if (fake.outcome === 'pending' && fake.pendingError) return { status: 'pending', hash, error: fake.pendingError };
      return { status: fake.outcome, hash };
    },
    receipt: async () => 'confirmed'
  };
  require(path.join(__dirname, '..', 'faucet', 'sender.js')).createSender = () => fake;
  Object.assign(process.env, {
    FAUCET_ENABLED: 'true',
    FAUCET_CHANNEL_ID: FAUCET_CHANNEL,
    FAUCET_VERIFIED_ROLE_ID: VERIFIED,
    FAUCET_PRIVATE_KEY: '0x' + '11'.repeat(32),
    AZTEC_RPC_URL: 'http://sepolia.invalid'
  });
  const h = await loadBot(url, 'faucet_flow_test');
  const claims = async () => (await h.pool.query('SELECT discord_user_id, wallet_address, tier, amount::text, status FROM faucet_claims ORDER BY id')).rows;
  const press = (p) => h.interact('button', 'faucet_request', p.user, p.extra);
  const submit = (p, values) => h.interact('modal', 'faucet_form', p.user, { ...p.extra, ...h.form(values) });
  const begin = async () => { await h.reset(); fake.sent.length = 0; fake.outcome = 'confirmed'; fake.throwOnSend = false; fake.throwAfterSigned = false; fake.pendingError = null; };
  // Staff in the faucet's server: Discord sends these fields with a command.
  const STAFF = { inGuild: () => true, memberPermissions: { has: () => true } };
  const W1 = '0x' + '1'.repeat(40);
  const seed = (user, wallet, whole) => h.pool.query(
    "INSERT INTO faucet_claims (discord_user_id, wallet_address, tier, amount, status) VALUES ($1, $2, 1, $3, 'confirmed')",
    [user, wallet.toLowerCase(), (BigInt(whole) * UNIT).toString()]);

  await t.test('/faucet-panel posts the panel with the button', async () => {
    await begin();
    await h.interact('command', 'faucet-panel', { id: '9', username: 'staff' }, { commandName: 'faucet-panel', channelId: FAUCET_CHANNEL, ...STAFF });
    const payload = h.lastAnswer;
    assert.match(h.text(payload), /Testnet STK Faucet/);
    for (const part of ['200,000 STK', '90 days', '7 days', '400,000 STK', 'Sepolia ETH', 'sequencer-role']) {
      assert.ok(h.text(payload).includes(part), part);
    }
    assert.ok(!/\{\{/.test(h.text(payload)));
    // The register hint is for members, and it names the configured operator wait.
    assert.match(h.text(payload), /• Members: once every 90 days\. Run a testnet sequencer\? Register it in the sequencer-role channel to claim every 7 days\.\n/);
    assert.ok(!/every week/.test(h.text(payload)));
    const button = payload.components[0].components[0].data;
    assert.equal(button.custom_id, 'faucet_request');
    // Commands are registered on the ready event, which the harness never fires.
    const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    assert.match(source, /checkStatusNowCommand, faucetPanelCommand, faucetResetCommand\]/);
  });

  await t.test('/faucet-panel outside the faucet channel posts nothing and names the channel', async () => {
    await begin();
    const staff = { id: '9', username: 'staff' };
    const before = h.sentPayloads.length;
    await h.interact('command', 'faucet-panel', staff, { commandName: 'faucet-panel', channelId: '999', ...STAFF });
    const sent = h.sentPayloads.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, `Run /faucet-panel in the faucet channel <#${FAUCET_CHANNEL}>.`);
    assert.equal(sent[0].flags, MessageFlags.Ephemeral);
    assert.ok(!sent[0].embeds);
  });

  await t.test('/faucet-panel without the Manage Roles permission posts nothing', async () => {
    await begin();
    const staff = { id: '9', username: 'staff' };
    for (const extra of [{}, { inGuild: () => true, memberPermissions: { has: () => false } }]) {
      const before = h.sentPayloads.length;
      await h.interact('command', 'faucet-panel', staff, { commandName: 'faucet-panel', channelId: FAUCET_CHANNEL, ...extra });
      const sent = h.sentPayloads.slice(before);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].content, 'Only staff with the Manage Roles permission can post the faucet panel.');
      assert.equal(sent[0].flags, MessageFlags.Ephemeral);
      assert.ok(!sent[0].embeds);
    }
  });

  await t.test('/faucet-panel that cannot be posted tells the staff member', async (t2) => {
    const wasSilent = logger.silent;
    logger.silent = true;
    t2.after(() => { logger.silent = wasSilent; });
    await begin();
    const answers = [];
    let calls = 0;
    await h.interact('command', 'faucet-panel', { id: '9', username: 'staff' }, {
      commandName: 'faucet-panel',
      channelId: FAUCET_CHANNEL,
      ...STAFF,
      reply: async (payload) => { calls += 1; if (calls === 1) throw new Error('Missing Permissions'); answers.push(payload); }
    });
    assert.deepEqual(answers, [{ content: 'The panel could not be posted. Check the bot permissions in this channel.', flags: MessageFlags.Ephemeral }]);
  });

  // The flow without bot.js, for the options that bot.js does not set.
  const direct = (options) => createFaucet({
    config: loadFaucetConfig(process.env), pool: h.pool, sender: fake, post: async () => {}, alert: async () => {}, ...options
  });

  await t.test('startup recovery leaves rows that changed after the process started', async () => {
    await begin();
    const T0 = new Date('2026-11-01T00:00:00Z');
    let now = T0;
    const faucet = direct({ clock: () => now });
    const insert = (minutes) => h.pool.query(
      `INSERT INTO faucet_claims (discord_user_id, wallet_address, tier, amount, status, created_at, updated_at)
       VALUES ('1', $1, 1, 1, 'reserved', $2, $2) RETURNING id`,
      [W1, new Date(T0.getTime() + minutes * 60000)]).then((r) => r.rows[0].id);
    const before = await insert(-1);
    const after = await insert(1);
    now = new Date(T0.getTime() + 2 * 60000);
    await faucet.recover();
    const statusOf = async (id) => (await h.pool.query('SELECT status FROM faucet_claims WHERE id = $1', [id])).rows[0].status;
    assert.equal(await statusOf(before), 'failed');
    assert.equal(await statusOf(after), 'reserved');
  });

  await t.test('the form has one row, the address, for both rules', async () => {
    await begin();
    for (const roles of [[VERIFIED], [VERIFIED, h.TESTNET_ROLE]]) {
      const p = person(26, { roles });
      const modals = [];
      await direct().button({ user: p.user, ...p.extra, reply: async (payload) => modals.push(payload), showModal: async (modal) => modals.push(modal) });
      assert.equal(modals.length, 1);
      assert.deepEqual(modals[0].components.map((row) => row.components[0].data.label), ['Your Sepolia wallet address']);
    }
  });

  await t.test('the button answers in time when the token unit is not ready', async (t2) => {
    const wasSilent = logger.silent;
    logger.silent = true;
    t2.after(() => { logger.silent = wasSilent; });
    await begin();
    const slow = { ...fake, unit: () => new Promise(() => {}) };
    const faucet = direct({ sender: slow, unitTimeoutMs: 20 });
    const p = person(24);
    const answers = [];
    await faucet.button({
      user: p.user, ...p.extra, customId: 'faucet_request',
      reply: async (payload) => answers.push(payload),
      showModal: async () => answers.push('modal')
    });
    assert.deepEqual(answers, [{ content: 'The faucet is not ready yet. Try again in a minute.', flags: MessageFlags.Ephemeral }]);
    const broken = direct({ sender: { ...fake, unit: async () => { throw new Error('rpc down'); } } });
    answers.length = 0;
    await broken.button({ user: p.user, ...p.extra, reply: async (payload) => answers.push(payload), showModal: async () => answers.push('modal') });
    assert.equal(answers[0].content, 'The faucet is not ready yet. Try again in a minute.');
  });

  await t.test('a member claim sends 200,000 STK under the member rule', async () => {
    await begin();
    const p = person(1);
    assert.equal(await press(p), 'modal faucet_form');
    const answer = await submit(p, { faucet_address: W1 });
    assert.match(answer, /200,000 STK/);
    assert.match(answer, /sepolia\.etherscan\.io\/tx\/0x0+1/);
    assert.deepEqual(await claims(), [{ discord_user_id: p.user.id, wallet_address: W1, tier: 1, amount: (200000n * UNIT).toString(), status: 'confirmed' }]);
    assert.ok(h.adminMessages.some((m) => m.includes('member rule') && m.includes(W1)));
  });

  await t.test('a member with the testnet sequencer role gets 200,000 STK under the operator rule', async () => {
    await begin();
    const p = person(2, { roles: [VERIFIED, h.TESTNET_ROLE] });
    await press(p);
    await submit(p, { faucet_address: W1 });
    const [claim] = await claims();
    assert.equal(claim.amount, (200000n * UNIT).toString());
    assert.equal(claim.tier, 2);
    assert.ok(h.adminMessages.some((m) => m.includes('operator rule')));
  });

  await t.test('a member with only the mainnet role gets the member rule', async () => {
    await begin();
    const p = person(3, { roles: [VERIFIED, h.MAINNET_ROLE] });
    await press(p);
    await submit(p, { faucet_address: W1 });
    assert.equal((await claims())[0].tier, 1);
  });

  await t.test('a wrong address, the zero address and the faucet wallet are refused', async () => {
    await begin();
    const p = person(4);
    assert.match(await submit(p, { faucet_address: '0x1234' }), /valid Ethereum address/);
    assert.match(await submit(p, { faucet_address: '0x' + '0'.repeat(40) }), /valid Ethereum address/);
    assert.match(await submit(p, { faucet_address: FAUCET_WALLET }), /faucet wallet/);
    assert.equal(fake.sent.length, 0);
  });

  await t.test('an ICAP address and a bad checksum are refused', async () => {
    await begin();
    const p = person(21);
    const lower = '0x' + 'ab'.repeat(20);
    const checksummed = ethers.getAddress(lower);
    const i = checksummed.search(/[a-fA-F]/);
    const flipped = checksummed[i] === checksummed[i].toUpperCase() ? checksummed[i].toLowerCase() : checksummed[i].toUpperCase();
    const badChecksum = checksummed.slice(0, i) + flipped + checksummed.slice(i + 1);
    assert.match(await submit(p, { faucet_address: ethers.getIcapAddress(lower) }), /valid Ethereum address/);
    assert.match(await submit(p, { faucet_address: badChecksum }), /valid Ethereum address/);
    assert.equal((await claims()).length, 0);
    assert.equal(fake.sent.length, 0);
  });

  await t.test('a mixed-case address counts against the same wallet limit', async () => {
    await begin();
    const lower = '0x' + 'ab'.repeat(20);
    await seed('other-user', lower, 1900000);
    const p = person(22);
    assert.match(await submit(p, { faucet_address: ethers.getAddress(lower) }), /wallet reached its 30-day/);
    assert.equal((await claims()).filter((c) => c.discord_user_id === p.user.id).length, 0);
  });

  await t.test('each refusal before the form gives its reason', async () => {
    await begin();
    assert.match(await press(person(5, { roles: [] })), /Verified role/);
    assert.match(await press(person(6, { accountDays: 10 })), /account is too new/);
    assert.match(await press(person(7, { serverDays: 1 })), /joined this server/);
    assert.match(await press(person(8, { timeoutUntil: new Date(Date.now() + DAY) })), /timeout/);
    assert.match(await press(person(9, { flags: 128 })), /AutoMod/);
    assert.match(await press(person(10, { channelId: '999' })), /faucet channel/);
    assert.equal((await claims()).length, 0);
  });

  await t.test('a second member claim is refused with the date and the operator hint', async () => {
    await begin();
    const p = person(11);
    await submit(p, { faucet_address: W1 });
    const refusal = await press(p);
    const expected = Math.floor((Date.now() + 90 * DAY) / 1000);
    const shown = Number(/<t:(\d+):f>/.exec(refusal)[1]);
    assert.ok(Math.abs(shown - expected) < 60, refusal);
    assert.match(refusal, /Register it in the sequencer-role channel to claim every 7 days\./);
  });

  await t.test('an operator refusal after a claim has no hint', async () => {
    await begin();
    const p = person(27, { roles: [VERIFIED, h.TESTNET_ROLE] });
    await submit(p, { faucet_address: W1 });
    const refusal = await press(p);
    assert.match(refusal, /next claim is possible from/);
    assert.ok(!/sequencer-role/.test(refusal));
  });

  await t.test('a failed transfer frees the quota and alerts staff', async () => {
    await begin();
    const p = person(12);
    fake.outcome = 'failed';
    assert.match(await submit(p, { faucet_address: W1 }), /failed/);
    assert.equal((await claims())[0].status, 'failed');
    assert.ok(h.adminMessages.some((m) => m.includes('failed')));
    fake.outcome = 'confirmed';
    assert.equal(await press(p), 'modal faucet_form');
  });

  await t.test('a pending transfer keeps counting and says so', async () => {
    await begin();
    const p = person(13);
    fake.outcome = 'pending';
    assert.match(await submit(p, { faucet_address: W1 }), /waits for confirmation/);
    assert.equal((await claims())[0].status, 'sent');
  });

  await t.test('a pending transfer with a broadcast error tells staff the error and the member not to request again', async () => {
    await begin();
    const p = person(19);
    fake.outcome = 'pending';
    fake.pendingError = 'insufficient funds for gas';
    const before = h.adminMessages.length;
    assert.match(await submit(p, { faucet_address: W1 }), /status is unknown.*Do not request again/s);
    assert.equal((await claims())[0].status, 'sent');
    const lines = h.adminMessages.slice(before);
    assert.ok(lines.some((m) => m.includes('broadcast answered: insufficient funds for gas')), lines.join('\n'));
  });

  await t.test('a send that throws releases the reservation and the member can try again', async (t2) => {
    const wasSilent = logger.silent;
    logger.silent = true;
    t2.after(() => { logger.silent = wasSilent; });
    await begin();
    const p = person(14);
    fake.throwOnSend = true;
    assert.match(await submit(p, { faucet_address: W1 }), /could not start/);
    assert.equal((await claims())[0].status, 'failed');
    assert.ok(h.adminMessages.some((m) => m.includes('could not start') && m.includes('rpc down')));
    fake.throwOnSend = false;
    assert.equal(await press(p), 'modal faucet_form');
  });

  await t.test('a send that throws after the broadcast keeps the claim and says the status is unknown', async (t2) => {
    const wasSilent = logger.silent;
    logger.silent = true;
    t2.after(() => { logger.silent = wasSilent; });
    await begin();
    const p = person(20);
    fake.throwAfterSigned = true;
    assert.match(await submit(p, { faucet_address: W1 }), /status is unknown\. Staff are informed\. Do not request again/);
    assert.equal((await claims())[0].status, 'sent');
    assert.ok(h.adminMessages.some((m) => m.includes('status unknown') && m.includes('receipt read failed')));
  });

  await t.test('the claim line in the admin channel pings nobody', async () => {
    await begin();
    const payloads = [];
    const realFetch = h.clients[0].channels.fetch;
    h.clients[0].channels.fetch = async () => ({ send: async (payload) => { payloads.push(payload); } });
    try {
      await submit(person(25), { faucet_address: W1 });
    } finally {
      h.clients[0].channels.fetch = realFetch;
    }
    assert.ok(payloads.some((p) => p.content.includes('received')));
    for (const payload of payloads) assert.deepEqual(payload.allowedMentions, { parse: [] });
  });

  await t.test('the staff line is posted even when the member answer fails', async (t2) => {
    const wasSilent = logger.silent;
    logger.silent = true;
    t2.after(() => { logger.silent = wasSilent; });
    await begin();
    const p = person(23);
    await h.interact('modal', 'faucet_form', p.user, {
      ...p.extra, ...h.form({ faucet_address: W1 }), editReply: async () => { throw new Error('unknown interaction'); }
    });
    assert.ok(h.adminMessages.some((m) => m.includes('member rule') && m.includes('received') && m.includes(W1)));
    assert.equal((await claims())[0].status, 'confirmed');
  });

  await t.test('an aborted transfer is failed and frees the quota', async () => {
    await begin();
    const p = person(15);
    fake.outcome = 'aborted';
    assert.match(await submit(p, { faucet_address: W1 }), /failed/);
    assert.equal((await claims())[0].status, 'failed');
  });

  await t.test('the daily cap for everyone refuses the claim and alerts staff', async () => {
    await begin();
    await seed('other-user', '0x' + '9'.repeat(40), 10000000);
    const p = person(16);
    assert.match(await submit(p, { faucet_address: W1 }), /daily limit/);
    assert.equal((await claims()).filter((c) => c.discord_user_id === p.user.id).length, 0);
    assert.ok(h.adminMessages.some((m) => m.includes('daily cap')));
  });

  await t.test('a daily-cap alert that cannot be posted is posted by the next claim', async (t2) => {
    await begin();
    await seed('other-user', '0x' + '9'.repeat(40), 10000000);
    const realFetch = h.clients[0].channels.fetch;
    const wasSilent = logger.silent;
    logger.silent = true;
    t2.after(() => { h.clients[0].channels.fetch = realFetch; logger.silent = wasSilent; });
    h.clients[0].channels.fetch = async () => ({ send: async () => { throw new Error('discord down'); } });
    const first = person(18);
    assert.match(await submit(first, { faucet_address: W1 }), /daily limit/); // the member still gets the answer
    assert.equal((await h.pool.query('SELECT 1 FROM faucet_alerts')).rowCount, 0);
    h.clients[0].channels.fetch = realFetch;
    logger.silent = wasSilent;
    assert.match(await submit(person(19), { faucet_address: W1 }), /daily limit/);
    assert.ok(h.adminMessages.some((m) => m.includes('daily cap')));
  });

  await t.test('the wallet limit refuses a wallet that received its 30-day maximum', async () => {
    await begin();
    await seed('other-user', W1, 2000000);
    const p = person(17);
    assert.match(await submit(p, { faucet_address: W1 }), /wallet reached its 30-day/);
    assert.equal((await claims()).filter((c) => c.discord_user_id === p.user.id).length, 0);
  });

  const resetBy = (member, reason = 'slashed after upgrade') => h.interact('command', 'faucet-reset', { id: '9', username: 'staff' }, {
    commandName: 'faucet-reset',
    inGuild: () => true,
    memberPermissions: { has: () => true },
    options: { getUser: () => member, getString: () => reason }
  });

  await t.test('/faucet-reset waives confirmed claims and the member can claim again', async () => {
    await begin();
    const p = person(30);
    await submit(p, { faucet_address: W1 });
    assert.match(await press(p), /next claim is possible/);
    const answer = await resetBy(p.user);
    const id = (await h.pool.query('SELECT id FROM faucet_claims')).rows[0].id;
    assert.match(answer, new RegExp(`#${id} `));
    assert.match(answer, /200,000 STK/);
    assert.match(answer, /^Reset 1 claim of member30:/);
    assert.match(answer, /The member rules allow a new claim now\. The wallet limit and the daily cap still apply\.$/);
    assert.ok(h.adminMessages.some((m) => m.includes('reset 1 claim of member30') && m.includes('Reason: slashed after upgrade')));
    assert.equal(await press(p), 'modal faucet_form');
  });

  await t.test('/faucet-reset refuses while a claim is sent and names its nonce', async () => {
    await begin();
    const p = person(31);
    const { rows } = await h.pool.query(
      "INSERT INTO faucet_claims (discord_user_id, wallet_address, tier, amount, status, nonce) VALUES ($1, $2, 1, $3, 'sent', 7) RETURNING id",
      [p.user.id, W1, (200000n * UNIT).toString()]);
    await seed(p.user.id, W1, 200000);
    const before = h.adminMessages.length;
    const answer = await resetBy(p.user);
    assert.match(answer, new RegExp(`claim #${rows[0].id}`));
    assert.match(answer, /nonce 7/);
    assert.equal((await h.pool.query('SELECT 1 FROM faucet_claims WHERE waived_at IS NOT NULL')).rowCount, 0);
    assert.equal(h.adminMessages.length, before);
  });

  await t.test('/faucet-reset from another server is refused', async () => {
    await begin();
    const p = person(33);
    await submit(p, { faucet_address: W1 });
    const before = h.adminMessages.length;
    const answer = await h.interact('command', 'faucet-reset', { id: '9', username: 'staff' }, {
      commandName: 'faucet-reset',
      ...STAFF,
      guild: { id: '2', channels: { cache: new Map() } },
      options: { getUser: () => p.user, getString: () => null }
    });
    assert.equal(answer, 'Run /faucet-reset in the server of the faucet channel.');
    assert.equal(h.lastAnswer.flags, MessageFlags.Ephemeral);
    assert.equal((await h.pool.query('SELECT 1 FROM faucet_claims WHERE waived_at IS NOT NULL')).rowCount, 0);
    assert.equal(h.adminMessages.length, before);
  });

  await t.test('/faucet-reset refuses when the server is not in the bot cache', async () => {
    await begin();
    const p = person(34);
    await submit(p, { faucet_address: W1 });
    const answer = await h.interact('command', 'faucet-reset', { id: '9', username: 'staff' }, {
      commandName: 'faucet-reset',
      ...STAFF,
      guild: null,
      options: { getUser: () => p.user, getString: () => null }
    });
    assert.equal(answer, 'Run /faucet-reset in the server of the faucet channel.');
    assert.equal((await h.pool.query('SELECT 1 FROM faucet_claims WHERE waived_at IS NOT NULL')).rowCount, 0);
  });

  await t.test('/faucet-reset with no claims says so', async () => {
    await begin();
    assert.match(await resetBy({ id: '12345', username: 'nobody' }), /No confirmed claims to reset/);
  });
  // A reset without bot.js, to control the interaction, the unit read and the admin post.
  const resetDirect = async (faucet, target, over = {}) => {
    const answers = [];
    const deferred = [];
    await faucet.reset({
      user: { id: '9', username: 'staff' },
      inGuild: () => true,
      memberPermissions: { has: () => true },
      guild: { id: '1', channels: { cache: new Map([[FAUCET_CHANNEL, {}]]) } },
      options: { getUser: () => target, getString: () => 'why' },
      deferReply: async (payload) => deferred.push(payload),
      reply: async (payload) => answers.push(payload),
      editReply: async (payload) => answers.push(payload),
      ...over
    });
    return { answers, deferred };
  };
  const seedMany = async (user, count) => {
    for (let i = 0; i < count; i += 1) await seed(user, W1, 200000);
  };

  await t.test('/faucet-reset refuses a caller without the Manage Roles permission', async () => {
    await begin();
    const p = person(32);
    await submit(p, { faucet_address: W1 });
    const staff = { id: '9', username: 'staff' };
    for (const extra of [{}, { inGuild: () => true, memberPermissions: { has: () => false } }, { inGuild: () => false, memberPermissions: { has: () => true } }]) {
      const before = h.adminMessages.length;
      await h.interact('command', 'faucet-reset', staff, { commandName: 'faucet-reset', options: { getUser: () => p.user, getString: () => null }, ...extra });
      assert.equal(h.lastAnswer.content, 'Only staff with the Manage Roles permission can reset faucet claims.');
      assert.equal(h.lastAnswer.flags, MessageFlags.Ephemeral);
      assert.equal((await h.pool.query('SELECT 1 FROM faucet_claims WHERE waived_at IS NOT NULL')).rowCount, 0);
      assert.equal(h.adminMessages.length, before);
    }
  });

  await t.test('/faucet-reset defers ephemerally and stores the reason on the claims', async () => {
    await begin();
    await seed('rs1', W1, 200000);
    const { answers, deferred } = await resetDirect(direct(), { id: 'rs1', username: 'someone' });
    assert.deepEqual(deferred, [{ flags: MessageFlags.Ephemeral }]);
    assert.match(answers[0].content, /^Reset 1 claim of someone:/);
    assert.equal((await h.pool.query('SELECT waived_reason FROM faucet_claims')).rows[0].waived_reason, 'why');
  });

  await t.test('/faucet-reset answers with 18 decimals when the unit is not ready', async (t2) => {
    const wasSilent = logger.silent;
    logger.silent = true;
    t2.after(() => { logger.silent = wasSilent; });
    await begin();
    await seedMany('rs2', 2);
    const posts = [];
    const slow = direct({ sender: { ...fake, unit: () => new Promise(() => {}) }, unitTimeoutMs: 20, post: async (m) => posts.push(m) });
    const { answers } = await resetDirect(slow, { id: 'rs2', username: 'slowone' });
    assert.match(answers[0].content, /^Reset 2 claims of slowone:/);
    assert.match(answers[0].content, /200,000 STK/);
    assert.equal(posts.length, 1);
    assert.ok(posts[0].includes('reset 2 claims of slowone'));
  });

  await t.test('/faucet-reset still reports the waive when the admin post fails', async (t2) => {
    const wasSilent = logger.silent;
    logger.silent = true;
    t2.after(() => { logger.silent = wasSilent; });
    await begin();
    await seed('rs3', W1, 200000);
    const failing = direct({ post: async () => { throw new Error('discord down'); } });
    const { answers } = await resetDirect(failing, { id: 'rs3', username: 'postfail' });
    assert.equal(answers.length, 1);
    assert.match(answers[0].content, /^Reset 1 claim of postfail:/);
    assert.equal((await h.pool.query('SELECT 1 FROM faucet_claims WHERE waived_at IS NOT NULL')).rowCount, 1);
  });

  await t.test('/faucet-reset lists at most 20 claims', async () => {
    await begin();
    await seedMany('rs4', 22);
    const { answers } = await resetDirect(direct(), { id: 'rs4', username: 'many' });
    const lines = answers[0].content.split('\n');
    assert.equal(lines[0], 'Reset 22 claims of many:');
    assert.equal(lines.filter((l) => l.startsWith('#')).length, 20);
    assert.ok(lines.includes('… and 2 more'));
  });

  await t.test('/faucet-reset on oneself is allowed and marked in the admin line', async () => {
    await begin();
    await seed('9', W1, 200000);
    const posts = [];
    const { answers } = await resetDirect(direct({ post: async (m) => posts.push(m) }), { id: '9', username: 'staff' });
    assert.match(answers[0].content, /^Reset 1 claim of staff:/);
    assert.equal(posts.length, 1);
    assert.ok(posts[0].endsWith(' (self-reset)'), posts[0]);
  });
  await t.test('the reset command is guild-only and cuts the reason at 200 characters', () => {
    const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    const builder = source.slice(source.indexOf("const faucetResetCommand"), source.indexOf('// A wrong faucet setting'));
    assert.match(builder, /\.setContexts\(InteractionContextType\.Guild\)/);
    assert.match(builder, /setName\('reason'\)[^\n]*\.setMaxLength\(200\)/);
  });
});
