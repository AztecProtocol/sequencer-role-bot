const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { loadBot } = require('./helpers/discordHarness.js');

// Needs a disposable Postgres (see README).
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';

const OPERATOR = { id: '900000000000000001', username: 'operator' };

test('scheduled status job', { skip }, async (t) => {
  const bot = await loadBot(url, 'bot_status_job');
  t.after(() => bot.pool.end());
  t.beforeEach(() => bot.reset());

  const hasRole = () => bot.rolesOf(OPERATOR.id).has(bot.MAINNET_ROLE);
  const status = async () => (await bot.record(OPERATOR)).status;
  const messages = () => bot.directMessages.map((message) => message.title);

  // An operator who registered a month ago with a healthy attester.
  async function longTimeOperator() {
    const wallet = ethers.Wallet.createRandom();
    const set = (state) => bot.chain.set(wallet.address.toLowerCase(), state);
    set('HEALTHY');
    await bot.register(OPERATOR, wallet);
    await bot.pool.query("UPDATE pending_registrations SET created_at = NOW() - INTERVAL '30 days'");
    return { set };
  }
  // Move the start of the at-risk period into the past.
  const atRiskFor = (days) =>
    bot.pool.query(`UPDATE pending_registrations SET at_risk_since = NOW() - INTERVAL '${days} days'`);

  await t.test('a canonical rollup change goes to the admin channel once', async (tt) => {
    tt.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const { resolveRollupAddress } = require('../rollupResolver.js');
    const V5 = '0x91fF8bbD8Ebb07893010D50A48A1609e5EBd8E34';
    const V6 = '0x00000000000000000000000000000000000000B6';
    let current = V5;
    const readCanonical = async () => current;
    await resolveRollupAddress('rollup-change-test', { readCanonical });
    current = V6;
    tt.mock.timers.tick(10 * 60 * 1000);
    await resolveRollupAddress('rollup-change-test', { readCanonical });
    await new Promise((resolve) => setImmediate(resolve));

    const posted = bot.adminMessages.filter((m) => m.includes('canonical rollup'));
    assert.deepEqual(posted.map((m) => m.replace(/^\[[^\]]+\] /, '')), [
      `ℹ️ The canonical rollup for rollup-change-test changed from ${V5} to ${V6}. Attesters that stay on the old rollup now read as inactive and follow the normal 7-day path.`
    ]);
  });

  await t.test('a healthy attester keeps the role and gets no message', async () => {
    await longTimeOperator();
    await bot.job.runGuardianCheck();
    assert.equal(hasRole(), true);
    assert.deepEqual(messages(), []);
  });

  await t.test('the first inactive reading sends one alert and keeps the role', async () => {
    const attester = await longTimeOperator();
    attester.set('INACTIVE');

    await bot.job.runGuardianCheck();

    assert.equal(hasRole(), true);
    assert.equal(await status(), 'at_risk');
    assert.deepEqual(messages(), ['🚨 Critical Alert: Node Inactive']);
  });

  await t.test('the role stays while the attester is inactive for less than seven days', async () => {
    const attester = await longTimeOperator();
    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();
    await atRiskFor(6);

    await bot.job.runGuardianCheck();

    assert.equal(hasRole(), true);
    assert.equal(await status(), 'at_risk');
    assert.deepEqual(messages(), ['🚨 Critical Alert: Node Inactive']);
  });

  await t.test('the role is removed after seven days of inactivity', async () => {
    const attester = await longTimeOperator();
    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();
    await atRiskFor(7);

    await bot.job.runGuardianCheck();

    assert.equal(hasRole(), false);
    assert.equal(await status(), 'removed');
    assert.deepEqual(messages(), ['🚨 Critical Alert: Node Inactive', '❌ Sequencer Role Removed']);
  });

  await t.test('a role removal that Discord refuses is reported and done in the next run', async () => {
    const attester = await longTimeOperator();
    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();
    await atRiskFor(7);
    const { rows: [before] } = await bot.pool.query('SELECT at_risk_since FROM pending_registrations');

    bot.failRoleRemovals = true;
    await bot.job.runGuardianCheck();

    assert.equal(await status(), 'at_risk');
    assert.equal(hasRole(), true);
    assert.deepEqual((await bot.record(OPERATOR)).at_risk_since, before.at_risk_since);
    assert.ok(bot.adminMessages.some((m) => m.includes('⚠️ Role removal failed for operator (900000000000000001) on Mainnet: Service Unavailable. The job tries again in the next run.')), bot.adminMessages.join('\n'));
    assert.deepEqual(messages(), ['🚨 Critical Alert: Node Inactive']);

    bot.failRoleRemovals = false;
    await bot.job.runGuardianCheck();

    assert.equal(await status(), 'removed');
    assert.equal(hasRole(), false);
    assert.deepEqual(messages(), ['🚨 Critical Alert: Node Inactive', '❌ Sequencer Role Removed']);
  });

  await t.test('an attester that recovers keeps the role, and a later inactivity gets seven new days', async () => {
    const attester = await longTimeOperator();
    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();
    await atRiskFor(6);

    attester.set('HEALTHY');
    await bot.job.runGuardianCheck();
    assert.equal(await status(), 'completed');

    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();
    await bot.job.runGuardianCheck();

    assert.equal(hasRole(), true);
    assert.equal(await status(), 'at_risk');
  });

  await t.test('an attester that returns as active with a reduced stake leaves the countdown', async () => {
    const attester = await longTimeOperator();
    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();

    attester.set('SLASHED');
    await bot.job.runGuardianCheck();
    await atRiskFor(8); // no effect on a registration that is not at risk
    await bot.job.runGuardianCheck();

    assert.equal(hasRole(), true);
    assert.equal(await status(), 'completed');
  });

  await t.test('an operator who registers again after a removal gets an alert for a new inactivity', async () => {
    const attester = await longTimeOperator();
    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();
    await atRiskFor(7);
    await bot.job.runGuardianCheck();
    assert.equal(await status(), 'removed');

    // The operator registers a new attester.
    await bot.pool.query('TRUNCATE signature_attempts');
    const next = ethers.Wallet.createRandom();
    bot.chain.set(next.address.toLowerCase(), 'HEALTHY');
    await bot.register(OPERATOR, next);
    assert.equal(hasRole(), true);
    bot.directMessages.length = 0;

    bot.chain.set(next.address.toLowerCase(), 'INACTIVE');
    await bot.job.runGuardianCheck();

    assert.deepEqual(messages(), ['🚨 Critical Alert: Node Inactive']);
    assert.equal(hasRole(), true);
  });

  await t.test('a registration that expired with no valid signature is not completed by the job', async () => {
    // Any account can enter the address of a healthy attester of a different operator.
    const foreign = ethers.Wallet.createRandom();
    bot.chain.set(foreign.address.toLowerCase(), 'HEALTHY');
    await bot.submitDetails(OPERATOR, foreign.address);
    const pending = await bot.record(OPERATOR);
    await bot.pool.query("UPDATE pending_registrations SET expires_at = NOW() - INTERVAL '1 hour'");
    await bot.submitSignature(OPERATOR, pending.id, '0x' + '00'.repeat(65));
    assert.equal(await status(), 'expired');

    await bot.job.runGuardianCheck();

    assert.equal(await status(), 'expired');
    assert.deepEqual(messages(), []);
  });

  await t.test('the alerts name the network and fill every value', async () => {
    const attester = await longTimeOperator();
    attester.set('INACTIVE');
    await bot.job.runGuardianCheck();
    await atRiskFor(7);
    await bot.job.runGuardianCheck();

    assert.equal(bot.directMessages.length, 2);
    for (const message of bot.directMessages) {
      assert.match(message.text, /Mainnet/);
      assert.doesNotMatch(message.text, /\{\{|Unknown/);
    }
  });

  await t.test('the slash warning shows the balances in AZTEC', async () => {
    const attester = await longTimeOperator();
    attester.set('SLASHED');
    await bot.job.runGuardianCheck();

    const [warning] = bot.directMessages;
    assert.match(warning.text, /196,?000(\.0)? AZTEC/);
    assert.match(warning.text, /200,?000(\.0)? AZTEC/);
    assert.doesNotMatch(warning.text, /196000000000000000000000/);
  });

  await t.test('a slashed attester gets one warning for three runs and keeps the role', async () => {
    const attester = await longTimeOperator();
    attester.set('SLASHED');

    await bot.job.runGuardianCheck();
    await bot.job.runGuardianCheck();
    await bot.job.runGuardianCheck();

    assert.equal(hasRole(), true);
    assert.deepEqual(messages(), ['⚠️ Warning: Stake Slashed']);
  });
});
