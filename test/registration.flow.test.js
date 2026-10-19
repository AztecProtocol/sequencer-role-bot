const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { loadBot } = require('./helpers/discordHarness.js');

// Needs a disposable Postgres (see README). Discord and the chain are replaced
// at their boundary, see helpers/discordHarness.js.
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';

const OPERATOR = { id: '900000000000000001', username: 'operator' };
const OTHER = { id: '900000000000000002', username: 'other' };

test('registration in Discord', { skip }, async (t) => {
  const bot = await loadBot(url, 'bot_registration_flow');
  t.after(() => bot.pool.end());
  t.beforeEach(() => bot.reset());

  const attester = () => {
    const wallet = ethers.Wallet.createRandom();
    bot.chain.set(wallet.address.toLowerCase(), 'HEALTHY');
    return wallet;
  };
  const hasRole = (user) => bot.rolesOf(user.id).has(bot.MAINNET_ROLE);

  await t.test('the bot registers its slash commands when the client is ready', async () => {
    const { Events } = require('discord.js');
    bot.client.user = { tag: 'bot#0001' };
    bot.client.emit(Events.ClientReady, bot.client);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bot.commandRegistrations.length, 1);
    const statusCommand = bot.commandBodies[0].map((c) => (c.toJSON ? c.toJSON() : c)).find((c) => c.name === 'check-status-now');
    assert.equal(statusCommand.description, 'Check your sequencer status now');
  });

  await t.test('an admin gets the registration panel from the register command', async () => {
    assert.equal(await bot.interact('command', undefined, OPERATOR, { commandName: 'register' }), 'Claim Your Sequencer Role');
  });

  await t.test('an operator who signs with an active attester key gets the mainnet role', async () => {
    await bot.register(OPERATOR, attester());
    assert.equal(hasRole(OPERATOR), true);
    assert.equal((await bot.record(OPERATOR)).status, 'completed');
  });

  await t.test('an address that is not an attester gets no role', async () => {
    const wallet = ethers.Wallet.createRandom(); // not on the chain
    await bot.register(OPERATOR, wallet);
    assert.equal(hasRole(OPERATOR), false);
  });

  await t.test('a signature from a different key is refused, and the correct signature then completes', async () => {
    const wallet = attester();
    await bot.submitDetails(OPERATOR, wallet.address);
    const pending = await bot.record(OPERATOR);

    await bot.submitSignature(OPERATOR, pending.id, await ethers.Wallet.createRandom().signMessage(pending.message_to_sign));
    assert.equal(hasRole(OPERATOR), false);

    await bot.submitSignature(OPERATOR, pending.id, await wallet.signMessage(pending.message_to_sign));
    assert.equal(hasRole(OPERATOR), true);
  });

  await t.test('the signature of one operator gives no role to a different account', async () => {
    const wallet = attester();
    await bot.submitDetails(OPERATOR, wallet.address);
    const operatorRecord = await bot.record(OPERATOR);
    const operatorSignature = await wallet.signMessage(operatorRecord.message_to_sign);

    await bot.submitDetails(OTHER, wallet.address);
    await bot.submitSignature(OTHER, (await bot.record(OTHER)).id, operatorSignature);
    await bot.submitSignature(OTHER, operatorRecord.id, operatorSignature);

    assert.equal(hasRole(OTHER), false);
  });

  for (const state of ['expired', 'removed', 'cancelled']) {
    await t.test(`an operator whose registration is ${state} can register again`, async () => {
      const wallet = attester();
      await bot.register(OPERATOR, wallet);
      await bot.pool.query('UPDATE pending_registrations SET status = $1', [state]);
      await bot.pool.query('TRUNCATE signature_attempts');
      bot.rolesOf(OPERATOR.id).clear();

      await bot.register(OPERATOR, wallet);

      assert.equal(hasRole(OPERATOR), true);
      assert.equal((await bot.record(OPERATOR)).status, 'completed');
    });
  }

  for (const state of ['completed', 'at_risk']) {
    await t.test(`the details form does not replace the attester of a registration that is ${state}`, async () => {
      const wallet = attester();
      await bot.register(OPERATOR, wallet);
      await bot.pool.query('UPDATE pending_registrations SET status = $1', [state]);
      await bot.pool.query('TRUNCATE signature_attempts');

      // A details form that the operator kept open, submitted with a foreign address.
      const foreign = attester();
      await bot.interact('modal', 'registration_modal_mainnet', OPERATOR, bot.textInput(foreign.address));

      const stored = await bot.record(OPERATOR);
      assert.equal(stored.wallet_address, wallet.address);
      assert.equal(stored.status, state);
    });
  }

  const GRANT_FAILED_REPLY = '⚠️ Your registration is verified, but the bot could not give the role. A server admin was told. Start the registration again after the admin fixes it.';
  const selectMainnet = async (user) => {
    await bot.interact('button', 'register_new_sequencer', user);
    return bot.interact('select', 'network_select', user, { values: ['mainnet'] });
  };

  await t.test('a failed role grant is reported to the user and to the admins', async () => {
    bot.failRoleGrants = true;
    const before = bot.sentPayloads.length;
    const answer = await bot.register(OPERATOR, attester());
    assert.equal(answer, GRANT_FAILED_REPLY);
    assert.equal(hasRole(OPERATOR), false);
    assert.ok(bot.adminMessages.some((m) => /\] ⚠️ Role grant failed for registration: operator \(900000000000000001\) - Mainnet - Missing Permissions/.test(m)), bot.adminMessages.join('\n'));
    assert.ok(!bot.sentPayloads.slice(before).some((p) => p && p.embeds && p.embeds.some((e) => (e.data || e).title === '✅ Registration Complete!')));
  });

  await t.test('the next attempt gives the role of a completed registration that has no role', async () => {
    bot.failRoleGrants = true;
    await bot.register(OPERATOR, attester());
    bot.failRoleGrants = false;

    assert.equal(await selectMainnet(OPERATOR), '✅ Registration Complete!');
    assert.equal(hasRole(OPERATOR), true);
    assert.ok(bot.adminMessages.some((m) => /Role restored for operator \(900000000000000001\)/.test(m)));
  });

  await t.test('the details form also gives the role of a completed registration that has no role', async () => {
    await bot.register(OPERATOR, attester());
    bot.rolesOf(OPERATOR.id).clear();
    await bot.pool.query('TRUNCATE signature_attempts');
    assert.equal(await bot.interact('modal', 'registration_modal_mainnet', OPERATOR, bot.textInput(attester().address)), '✅ Registration Complete!');
    assert.equal(hasRole(OPERATOR), true);
  });

  await t.test('a failed repair is reported like a failed grant', async () => {
    await bot.register(OPERATOR, attester());
    bot.rolesOf(OPERATOR.id).clear();
    bot.adminMessages.length = 0;
    bot.failRoleGrants = true;
    assert.equal(await selectMainnet(OPERATOR), GRANT_FAILED_REPLY);
    assert.ok(bot.adminMessages.some((m) => /⚠️ Role grant failed for registration/.test(m)));
  });

  await t.test('a registration at risk does not get a removed role back', async () => {
    await bot.register(OPERATOR, attester());
    await bot.pool.query("UPDATE pending_registrations SET status = 'at_risk', at_risk_since = NOW()");
    bot.rolesOf(OPERATOR.id).clear();
    await selectMainnet(OPERATOR);
    await bot.pool.query('TRUNCATE signature_attempts');
    await bot.interact('modal', 'registration_modal_mainnet', OPERATOR, bot.textInput(attester().address));
    assert.equal(hasRole(OPERATOR), false);
  });

  // The bot waits 2 and 4 seconds between its three reads, so this test takes six seconds.
  await t.test('after a slow chain read, the user is told to start again, and a new start works', async () => {
    const wallet = attester();
    bot.chain.set(wallet.address.toLowerCase(), 'RPC_ERROR');
    await bot.register(OPERATOR, wallet);
    assert.equal(bot.text(bot.lastAnswer), '⏳ Verification Delayed\nThe network is slow right now, so the check did not finish. Please start the registration again in a few minutes.');
    assert.ok(bot.adminMessages.some((m) => m.includes('RPC failure for operator (900000000000000001)')), bot.adminMessages.join('\n'));
    assert.ok(!bot.adminMessages.some((m) => /retry/i.test(m)), bot.adminMessages.join('\n'));
    assert.equal(hasRole(OPERATOR), false);

    bot.chain.set(wallet.address.toLowerCase(), 'HEALTHY');
    await bot.pool.query('TRUNCATE signature_attempts');
    await bot.register(OPERATOR, wallet);
    assert.equal(hasRole(OPERATOR), true);
  });

  const statusText = async () => {
    await bot.interact('command', undefined, OPERATOR, { commandName: 'check-status-now' });
    return bot.text(bot.lastAnswer);
  };

  await t.test('the status command tells an operator with a completed registration that they have the role', async () => {
    await bot.register(OPERATOR, attester());
    assert.match(await statusText(), /You have the role/);
  });

  await t.test('the status command tells an operator at risk the date of the role removal', async () => {
    await bot.register(OPERATOR, attester());
    await bot.pool.query("UPDATE pending_registrations SET status = 'at_risk', at_risk_since = TIMESTAMPTZ '2026-10-01 12:00:00+00'");
    // 2026-10-08 12:00 UTC, seven days later, as a Discord date tag.
    assert.match(await statusText(), /removed on <t:1791460800:D>/);
  });

  await t.test('the status command tells an operator whose role was removed to register again', async () => {
    await bot.register(OPERATOR, attester());
    await bot.pool.query("UPDATE pending_registrations SET status = 'removed'");
    assert.match(await statusText(), /Register again/);
  });

  // discord.js 14 reports the 'ephemeral' option as deprecated, and version 15 removes it.
  await t.test('private answers use the ephemeral flag, not the removed ephemeral option', () => {
    const { MessageFlags } = require('discord.js');
    const objects = bot.sentPayloads.filter((payload) => payload && typeof payload === 'object');
    assert.deepEqual(objects.filter((payload) => 'ephemeral' in payload), []);
    assert.ok(objects.some((payload) => (payload.flags & MessageFlags.Ephemeral) !== 0));
  });
});
