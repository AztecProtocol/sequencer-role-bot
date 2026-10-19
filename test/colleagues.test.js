const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { loadBot } = require('./helpers/discordHarness.js');

// Needs a disposable Postgres (see README).
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';

const OPERATOR = { id: '900000000000000001', username: 'operator' };
const COLLEAGUE = { id: '900000000000000003', username: 'colleague' };
const SECOND_OPERATOR = { id: '900000000000000004', username: 'second' };

test('colleagues of an operator', { skip }, async (t) => {
  const bot = await loadBot(url, 'bot_colleagues');
  t.after(() => bot.pool.end());
  t.beforeEach(() => bot.reset());

  const hasRole = (user) => bot.rolesOf(user.id).has(bot.MAINNET_ROLE);
  const colleagueStatus = async () =>
    (await bot.pool.query('SELECT status FROM colleagues WHERE colleague_user_id = $1', [COLLEAGUE.id])).rows.map((r) => r.status);

  async function operatorWithAttester(user) {
    const wallet = ethers.Wallet.createRandom();
    bot.chain.set(wallet.address.toLowerCase(), 'HEALTHY');
    await bot.register(user, wallet);
    return { set: (state) => bot.chain.set(wallet.address.toLowerCase(), state) };
  }
  const addColleague = (manager, colleague) =>
    bot.interact('modal', 'manage_colleagues_modal', manager, bot.form({ discord_id_1: colleague.id }));
  const removeColleague = (manager, colleague) =>
    bot.interact('modal', 'remove_colleagues_modal', manager, bot.form({ discord_id_1: colleague.id }));
  const atRiskFor = (user, days) => bot.pool.query(
    `UPDATE pending_registrations SET at_risk_since = NOW() - INTERVAL '${days} days' WHERE discord_user_id = $1`, [user.id]);

  await t.test('a colleague gets the mainnet role of the operator', async () => {
    await operatorWithAttester(OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);
    assert.equal(hasRole(COLLEAGUE), true);
  });

  await t.test('a colleague keeps the role while the operator is at risk', async () => {
    const attester = await operatorWithAttester(OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);
    attester.set('INACTIVE');

    await bot.job.runGuardianCheck();
    await atRiskFor(OPERATOR, 6);
    await bot.job.runGuardianCheck();

    assert.equal(hasRole(OPERATOR), true);
    assert.equal(hasRole(COLLEAGUE), true);
  });

  await t.test('a colleague loses the role when the operator loses the role', async () => {
    const attester = await operatorWithAttester(OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);
    attester.set('INACTIVE');

    await bot.job.runGuardianCheck();
    await atRiskFor(OPERATOR, 7);
    await bot.job.runGuardianCheck();

    assert.equal(hasRole(OPERATOR), false);
    assert.equal(hasRole(COLLEAGUE), false);
  });

  await t.test('an active colleague gets the missing role when the operator registers again and adds them again', async () => {
    const attester = await operatorWithAttester(OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);
    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();
    await atRiskFor(OPERATOR, 7);
    await bot.job.runGuardianCheck();
    assert.equal(hasRole(COLLEAGUE), false);
    assert.deepEqual(await colleagueStatus(), ['active']);

    await bot.pool.query('TRUNCATE signature_attempts');
    await operatorWithAttester(OPERATOR);
    assert.equal(await addColleague(OPERATOR, COLLEAGUE), '✅ Success');
    assert.equal(hasRole(COLLEAGUE), true);
  });

  await t.test('a failed colleague role removal is reported to the admins', async () => {
    const attester = await operatorWithAttester(OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);
    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();
    await atRiskFor(OPERATOR, 7);

    bot.failRoleRemovals = COLLEAGUE.id;
    await bot.job.runGuardianCheck();

    assert.equal(hasRole(OPERATOR), false);
    assert.equal(hasRole(COLLEAGUE), true);
    assert.ok(bot.adminMessages.some((m) => m.includes('⚠️ Role removal failed for colleague 900000000000000003 of operator on mainnet: Service Unavailable.')), bot.adminMessages.join('\n'));
  });

  await t.test('a colleague who is also a registered operator keeps the own role', async () => {
    const attester = await operatorWithAttester(OPERATOR);
    await operatorWithAttester(COLLEAGUE);
    await addColleague(OPERATOR, COLLEAGUE);
    attester.set('INACTIVE');

    await bot.job.runGuardianCheck();
    await atRiskFor(OPERATOR, 7);
    await bot.job.runGuardianCheck();

    assert.equal(hasRole(OPERATOR), false);
    assert.equal(hasRole(COLLEAGUE), true);
  });

  await t.test('a colleague of two operators keeps the role while one operator still has it', async () => {
    const attester = await operatorWithAttester(OPERATOR);
    await operatorWithAttester(SECOND_OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);
    await addColleague(SECOND_OPERATOR, COLLEAGUE);
    attester.set('INACTIVE');

    await bot.job.runGuardianCheck();
    await atRiskFor(OPERATOR, 7);
    await bot.job.runGuardianCheck();

    assert.equal(hasRole(COLLEAGUE), true);
  });

  await t.test('a testnet removal takes only the testnet role from a colleague and keeps the colleague record', async (tt) => {
    // The harness configures mainnet only. This test also configures testnet.
    Object.assign(process.env, { AZTEC_RPC_URL: 'http://chain.invalid', AZTEC_REGISTRY_CONTRACT: '0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba' });
    tt.after(() => Object.assign(process.env, { AZTEC_RPC_URL: '', AZTEC_REGISTRY_CONTRACT: '' }));
    const { keepsRole } = require('../db/roleAccess.js');

    await operatorWithAttester(OPERATOR);
    const testnetAttester = ethers.Wallet.createRandom().address;
    await bot.pool.query(
      `INSERT INTO pending_registrations (discord_user_id, discord_username, network, wallet_address, message_to_sign, expires_at, status)
       VALUES ($1, $2, 'Testnet', $3, 'm', NOW(), 'completed')`, [OPERATOR.id, OPERATOR.username, testnetAttester]);
    await addColleague(OPERATOR, COLLEAGUE);
    assert.equal(bot.rolesOf(COLLEAGUE.id).has(bot.TESTNET_ROLE), true);

    await bot.pool.query(
      `UPDATE pending_registrations SET status = 'at_risk', at_risk_since = NOW() - INTERVAL '7 days'
       WHERE network = 'Testnet'`);
    await bot.job.runGuardianCheck();

    assert.equal((await bot.pool.query("SELECT status FROM pending_registrations WHERE network = 'Testnet'")).rows[0].status, 'removed');
    assert.equal(bot.rolesOf(COLLEAGUE.id).has(bot.TESTNET_ROLE), false);
    assert.equal(hasRole(COLLEAGUE), true);
    assert.equal(await keepsRole(bot.pool, COLLEAGUE.id, 'mainnet'), true);
    assert.deepEqual(await colleagueStatus(), ['active']);
  });

  await t.test('the operator removes a colleague, and the colleague loses the role', async () => {
    await operatorWithAttester(OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);

    await removeColleague(OPERATOR, COLLEAGUE);

    assert.equal(hasRole(COLLEAGUE), false);
    assert.deepEqual(await colleagueStatus(), ['removed']);
  });

  await t.test('a removed colleague does not get the role back when the operator recovers', async () => {
    const attester = await operatorWithAttester(OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);
    await removeColleague(OPERATOR, COLLEAGUE);
    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();

    attester.set('HEALTHY');
    await bot.job.runGuardianCheck();

    assert.equal(hasRole(COLLEAGUE), false);
  });

  await t.test('a removed colleague can be added again', async () => {
    await operatorWithAttester(OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);
    await removeColleague(OPERATOR, COLLEAGUE);

    await addColleague(OPERATOR, COLLEAGUE);

    assert.equal(hasRole(COLLEAGUE), true);
    assert.deepEqual(await colleagueStatus(), ['active']);
  });

  await t.test('an operator cannot remove the colleague of a different operator', async () => {
    await operatorWithAttester(OPERATOR);
    await operatorWithAttester(SECOND_OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);

    await removeColleague(SECOND_OPERATOR, COLLEAGUE);

    assert.equal(hasRole(COLLEAGUE), true);
    assert.deepEqual(await colleagueStatus(), ['active']);
  });

  const NEW_ID = { id: '900000000000000099', username: 'new' };
  const ACCESS_DENIED = '🚫 Access Denied';

  await t.test('a colleague without an own registration cannot add or remove colleagues', async () => {
    await operatorWithAttester(OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);
    assert.equal(hasRole(COLLEAGUE), true);

    assert.equal(await bot.interact('button', 'manage_colleagues', COLLEAGUE), ACCESS_DENIED);
    assert.equal(await bot.interact('button', 'remove_colleagues', COLLEAGUE), ACCESS_DENIED);
    assert.equal(await addColleague(COLLEAGUE, NEW_ID), ACCESS_DENIED);
    assert.equal(await removeColleague(COLLEAGUE, OPERATOR), ACCESS_DENIED);
    assert.equal(bot.rolesOf(NEW_ID.id).size, 0);
    assert.equal((await bot.pool.query('SELECT 1 FROM colleagues WHERE manager_discord_id = $1', [COLLEAGUE.id])).rows.length, 0);
  });

  await t.test('the shared legacy role is never given', async (tt) => {
    process.env.SEQUENCER_ROLE_ID = '444';
    tt.after(() => { process.env.SEQUENCER_ROLE_ID = ''; });
    const attester = await operatorWithAttester(OPERATOR);
    await addColleague(OPERATOR, COLLEAGUE);
    await addColleague(COLLEAGUE, NEW_ID);
    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();
    attester.set('HEALTHY');
    await bot.job.runGuardianCheck();

    for (const user of [OPERATOR, COLLEAGUE, NEW_ID]) assert.equal(bot.rolesOf(user.id).has('444'), false, user.username);
  });

  await t.test('an operator can have at most ten colleagues', async () => {
    await operatorWithAttester(OPERATOR);
    const ids = Array.from({ length: 11 }, (_, n) => `9100000000000000${String(n).padStart(2, '0')}`);
    const fields = (list) => Object.fromEntries(list.map((id, n) => [`discord_id_${n + 1}`, id]));
    await bot.interact('modal', 'manage_colleagues_modal', OPERATOR, bot.form(fields(ids.slice(0, 5))));
    await bot.interact('modal', 'manage_colleagues_modal', OPERATOR, bot.form(fields(ids.slice(5, 10))));

    // An active colleague again does not count twice.
    assert.equal(await bot.interact('modal', 'manage_colleagues_modal', OPERATOR, bot.form(fields([ids[0]]))), '✅ Success');

    // The whole submission is refused, also the id that is already a colleague.
    const answer = await bot.interact('modal', 'manage_colleagues_modal', OPERATOR, bot.form(fields([ids[1], ids[10]])));
    assert.equal(answer, '❌ You can have at most 10 colleagues. Remove one first.');
    assert.equal(bot.rolesOf(ids[10]).size, 0);
    const { rows } = await bot.pool.query("SELECT 1 FROM colleagues WHERE manager_discord_id = $1 AND status = 'active'", [OPERATOR.id]);
    assert.equal(rows.length, 10);
  });

  await t.test('a colleague who gets only one of two network roles is reported', async () => {
    await operatorWithAttester(OPERATOR);
    await bot.pool.query(
      `INSERT INTO pending_registrations (discord_user_id, discord_username, network, wallet_address, message_to_sign, expires_at, status)
       VALUES ($1, $2, 'Testnet', $3, 'm', NOW(), 'completed')`, [OPERATOR.id, OPERATOR.username, ethers.Wallet.createRandom().address]);
    bot.failRoleGrants = bot.TESTNET_ROLE;

    assert.equal(await addColleague(OPERATOR, COLLEAGUE), 'Colleague saved, but the bot could not give the role. A server admin was told.');
    assert.equal(hasRole(COLLEAGUE), true);
    assert.equal(bot.rolesOf(COLLEAGUE.id).has(bot.TESTNET_ROLE), false);
    const lines = bot.adminMessages.filter((m) => m.includes('⚠️ Role grant failed for colleague'));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /colleague 900000000000000003 of operator \(900000000000000001\) on Testnet: Missing Permissions/);
  });

  await t.test('the add and remove forms accept the same Discord id lengths', async () => {
    await operatorWithAttester(OPERATOR);
    const twentyDigits = { id: '91000000000000000001', username: 'long' };
    assert.equal(await addColleague(OPERATOR, twentyDigits), '✅ Success');
    assert.equal(bot.rolesOf(twentyDigits.id).has(bot.MAINNET_ROLE), true);
    assert.match(await removeColleague(OPERATOR, twentyDigits), /Removed/);
    assert.match(await addColleague(OPERATOR, { id: '1234567890123456', username: 'short' }), /Invalid Discord ID/);
    assert.match(await removeColleague(OPERATOR, { id: '1234567890123456', username: 'short' }), /Invalid Discord ID/);
  });

  await t.test('a failed colleague role grant is reported to the operator and to the admins', async () => {
    await operatorWithAttester(OPERATOR);
    bot.failRoleGrants = true;
    assert.equal(await addColleague(OPERATOR, COLLEAGUE), 'Colleague saved, but the bot could not give the role. A server admin was told.');
    assert.ok(bot.adminMessages.some((m) => m.includes('⚠️ Role grant failed for colleague 900000000000000003 of operator (900000000000000001)')), bot.adminMessages.join('\n'));
  });

  await t.test('the management panel has a button to remove colleagues', async () => {
    await operatorWithAttester(OPERATOR);
    await bot.interact('button', 'manage_sequencer', OPERATOR);
    const ids = bot.lastAnswer.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
    assert.ok(ids.includes('remove_colleagues'), JSON.stringify(ids));
    assert.equal(await bot.interact('button', 'remove_colleagues', OPERATOR), 'modal remove_colleagues_modal');
  });
});
