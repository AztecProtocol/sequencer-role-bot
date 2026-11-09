// The faucet as members see it: panel → button → form → transfer → answer.
// bot.js only routes the three interactions here.
const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { ethers } = require('ethers');
const { getEmbed, getActionRows } = require('../utils/embedManager.js');
const { memberFacts, checkEligibility } = require('./eligibility.js');
const ledger = require('./ledger.js');
const recovery = require('./recovery.js');
const logger = require('../utils/logger.js');

const BUTTON_ID = 'faucet_request';
const FORM_ID = 'faucet_form';
const ADDRESS_FIELD = 'faucet_address';
const RESET_LIST_MAX = 20;
const TX_URL = 'https://sepolia.etherscan.io/tx/';

const stk = (whole) => BigInt(whole).toLocaleString('en-US');
const when = (date) => `<t:${Math.floor(date.getTime() / 1000)}:f>`;
// A wait time for the panel: whole days when it is a multiple of 24 hours.
function waitText(hours) {
  if (hours === 24) return '1 day';
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24} days`;
  return `${hours} hours`;
}
// Staff for the faucet commands: a server member with Manage Roles. Fails closed.
const isStaff = (interaction) => Boolean(interaction.inGuild?.() && interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles));
const ruleName = (tier) => (tier === 2 ? 'operator rule' : 'member rule');
const again = (result) => (result.until ? ` You can claim again from ${when(result.until)}.` : '');

const REFUSALS = {
  disabled: () => 'The faucet is off at the moment. Staff will announce when it is back.',
  wrong_channel: () => 'Use the panel in the faucet channel.',
  not_verified: () => 'The faucet needs the Verified role. Complete the server verification first.',
  account_too_new: (r) => `Your Discord account is too new for the faucet. You can claim from ${when(r.until)}.`,
  server_too_new: (r) => `You joined this server too recently.${again(r)}`,
  timed_out: (r) => `You cannot use the faucet during a timeout. The timeout ends ${when(r.until)}.`,
  quarantined: () => 'AutoMod restricts your account in this server. Contact the moderators.',
  wait: (r) => `You claimed recently. Your next claim is possible from ${when(r.until)}.`,
  user_30d: (r) => `You reached your 30-day faucet limit.${again(r)}`,
  wallet_30d: (r) => `This wallet reached its 30-day faucet limit.${again(r)}`,
  global_24h: (r) => `The faucet reached its daily limit.${again(r)}`
};

// post never throws and carries the log lines; alert throws when the post fails,
// so the alert slot in recovery frees itself.
const NOT_READY = 'The faucet is not ready yet. Try again in a minute.';

function createFaucet({ config, pool, sender, post, alert, clock = () => new Date(), unitTimeoutMs = 2000 }) {
  const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
  // Startup recovery settles only rows that this process has not touched.
  const startedAt = clock();

  // Eligibility plus the tier limits. Returns { refusal } or { tier, limits, unit }.
  // readUnit returns null when the token unit is not available.
  async function admit(interaction, now, readUnit = () => sender.unit()) {
    const result = checkEligibility(memberFacts(interaction), config, now);
    if (!result.ok) return { refusal: REFUSALS[result.reason](result) };
    const unit = await readUnit();
    if (unit === null) return { refusal: NOT_READY };
    return { tier: result.tier, limits: ledger.tierLimits(config, result.tier, unit), unit };
  }

  // Discord waits 3 seconds for the button answer, and the first unit read
  // goes to the RPC. Gives up after unitTimeoutMs and returns null.
  async function unitInTime() {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${unitTimeoutMs} ms`)), unitTimeoutMs);
    });
    try {
      return await Promise.race([sender.unit(), timeout]);
    } catch (error) {
      logger.warn(`Faucet token unit not ready: ${error.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // A refusal for the member; the member rule also points to the operator rule.
  function refusalText(result, tier) {
    const hint = ` Run a testnet sequencer? Register it in the sequencer-role channel to claim every ${waitText(config.operator.waitHours)}.`;
    return REFUSALS[result.reason](result) + (result.reason === 'wait' && tier === 1 ? hint : '');
  }

  function form() {
    const address = new TextInputBuilder()
      .setCustomId(ADDRESS_FIELD)
      .setLabel('Your Sepolia wallet address')
      .setPlaceholder('0x...')
      .setStyle(TextInputStyle.Short)
      .setMinLength(42)
      .setMaxLength(42)
      .setRequired(true);
    const modal = new ModalBuilder()
      .setCustomId(FORM_ID)
      .setTitle('Request testnet STK')
      .addComponents(new ActionRowBuilder().addComponents(address));
    return modal;
  }

  async function panel(interaction) {
    let answered = false;
    try {
      if (!config.enabled) return await interaction.reply(ephemeral(REFUSALS.disabled()));
      // Discord also hides the command from other members, but the bot checks the permission itself.
      if (!isStaff(interaction)) return await interaction.reply(ephemeral('Only staff with the Manage Roles permission can post the faucet panel.'));
      if (interaction.channelId !== config.channelId) {
        return await interaction.reply(ephemeral(`Run /faucet-panel in the faucet channel <#${config.channelId}>.`));
      }
      const embed = getEmbed('faucet.panel', {
        accountDays: config.minAccountDays,
        serverDays: config.minServerDays,
        amount: stk(config.member.amount),
        memberWait: waitText(config.member.waitHours),
        operatorWait: waitText(config.operator.waitHours),
        operatorMax: stk(config.operator.max30d),
        walletMax: stk(config.walletMax30d)
      });
      await interaction.reply({ embeds: [embed], components: getActionRows('faucet.panel') });
      answered = true;
    } catch (error) {
      logger.error(`Faucet panel failed: ${error.message}`);
      if (!answered) {
        await interaction.reply(ephemeral('The panel could not be posted. Check the bot permissions in this channel.')).catch(() => {});
      }
    }
  }

  async function button(interaction) {
    try {
      const now = clock();
      const admitted = await admit(interaction, now, unitInTime);
      if (admitted.refusal) return await interaction.reply(ephemeral(admitted.refusal));
      const check = await ledger.nextClaimCheck(pool, { userId: interaction.user.id, limits: admitted.limits, now });
      if (!check.ok) return await interaction.reply(ephemeral(refusalText(check, admitted.tier)));
      await interaction.showModal(form());
    } catch (error) {
      logger.error(`Faucet button failed: ${error.message}`);
      await interaction.reply(ephemeral('The faucet could not check your request. Try again later.')).catch(() => {});
    }
  }

  async function submit(interaction) {
    let deferred = false;
    let answered = false;
    let reservation;
    let outcome;
    let who = interaction.user.id;
    let successText = '';
    const answer = (content) => (deferred ? interaction.editReply({ content }) : interaction.reply(ephemeral(content)));
    try {
      // First step: the chain calls below can be slow, and Discord waits 3 seconds.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      deferred = true;
      const now = clock();
      // The checks run again: a role or a timeout can change while the form is open.
      const admitted = await admit(interaction, now);
      if (admitted.refusal) return await answer(admitted.refusal);
      const { tier, limits, unit } = admitted;

      // Only the 0x form: ethers also accepts ICAP (XE...), which would give one
      // wallet a second key in the ledger. getAddress throws on a bad checksum.
      const raw = interaction.fields.getTextInputValue(ADDRESS_FIELD).trim();
      let wallet = null;
      if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
        try { wallet = ethers.getAddress(raw); } catch { wallet = null; }
      }
      if (!wallet || wallet === ethers.ZeroAddress) {
        return await answer('Enter a valid Ethereum address (0x followed by 40 hex characters).');
      }
      if (wallet.toLowerCase() === sender.address.toLowerCase()) {
        return await answer('That address is the faucet wallet. Enter your own wallet address.');
      }

      const amount = limits.maxAmount;

      reservation = await ledger.reserve(pool, {
        userId: interaction.user.id,
        wallet,
        limits,
        amount,
        walletMax30d: config.walletMax30d * unit,
        globalMax24h: config.globalMax24h * unit,
        now
      });
      if (!reservation.ok) {
        if (reservation.reason === 'global_24h') {
          await recovery.alertSafely(pool, 'global_cap', now, alert,
            '⚠️ The faucet reached its daily cap. New claims are refused until the 24-hour window frees up.');
        }
        return await answer(refusalText(reservation, tier));
      }

      who = `${interaction.user.username} (${interaction.user.id}), ${ruleName(tier)}`;
      outcome = await sender.send(wallet, amount, (hash, nonce) => ledger.markSent(pool, reservation.id, hash, clock(), nonce));
      const whole = stk(amount / unit);
      const link = outcome.hash ? `${TX_URL}${outcome.hash}` : '';

      if (outcome.status === 'confirmed') {
        successText = `✅ Sent ${whole} STK to ${wallet}.\nTransaction: ${link}`;
        if (!(await ledger.markConfirmed(pool, reservation.id, clock()))) {
          logger.warn(`Faucet claim ${reservation.id} is confirmed on chain, but its row was not in status sent`);
        }
        // The staff line first (post never throws): a failed member answer must not hide the claim.
        await post(`Faucet: ${who} received ${whole} STK at ${wallet} — ${link}`);
        await answer(successText);
        answered = true;
      } else if (outcome.status === 'pending' && outcome.error) {
        // The node answered the broadcast with an error: the transfer may or may not be on the chain.
        await post(`⚠️ Faucet: ${who} — ${whole} STK to ${wallet}, status unknown, broadcast answered: ${outcome.error} — ${link}`);
        await answer(`The transfer status is unknown. Staff are informed. Do not request again for now.\nTransaction: ${link}`);
      } else if (outcome.status === 'pending') {
        await post(`Faucet: ${who} — ${whole} STK to ${wallet} is sent, not yet confirmed — ${link}`);
        await answer(`⏳ The transfer of ${whole} STK to ${wallet} is sent and waits for confirmation.\nTransaction: ${link}`);
      } else {
        await ledger.markFailed(pool, reservation.id, outcome.error || outcome.status, clock());
        await post(`⚠️ Faucet transfer failed for ${who}, ${whole} STK to ${wallet}: ${outcome.error || outcome.status}`);
        await answer('❌ The transfer failed. This claim does not count against your limits. Staff are informed.');
      }

      recovery.checkBalances({ pool, sender, config, unit, post: alert, now: clock() })
        .catch((error) => logger.error(`Faucet balance check failed: ${error.message}`));
    } catch (error) {
      logger.error(`Faucet request failed: ${error.message}`);
      if (reservation && reservation.ok && !outcome) {
        // The send threw. If the row is still reserved, nothing was broadcast: free the quota.
        // If it is already sent, the transfer may have happened: the claim keeps counting.
        const released = await ledger.releaseReservation(pool, reservation.id, error.message, clock())
          .catch((releaseError) => {
            logger.error(`Faucet release failed: ${releaseError.message}`);
            return false;
          });
        if (released) {
          await answer('The transfer could not start. This claim does not count against your limits. Try again later.').catch(() => {});
          await Promise.resolve(post(`⚠️ Faucet transfer could not start for ${who}: ${error.message}`)).catch(() => {});
        } else {
          await answer('The transfer status is unknown. Staff are informed. Do not request again for now.').catch(() => {});
          await Promise.resolve(post(`⚠️ Faucet transfer status unknown for ${who}, claim ${reservation.id}: ${error.message}`)).catch(() => {});
        }
      } else if (outcome && outcome.status === 'confirmed') {
        // Funds moved: never tell the member the claim failed.
        if (!answered) await answer(successText || `✅ The transfer was sent.\nTransaction: ${TX_URL}${outcome.hash}`).catch(() => {});
      } else {
        await answer('The faucet could not complete your request. Try again later.').catch(() => {});
      }
    }
  }

  // At bot start no transfer of an earlier process is in flight, so every row
  // not updated since this process started is settled.
  async function recover() {
    if (!config.enabled) return null;
    // Warm the unit cache, so the first member request does not wait for the RPC.
    await sender.unit().catch((error) => logger.error(`Faucet unit lookup failed: ${error.message}`));
    try {
      const now = clock();
      const minAgeMs = Math.max(0, now.getTime() - startedAt.getTime());
      return await recovery.settleClaims({ pool, sender, post: alert, now, minAgeMs });
    } catch (error) {
      logger.error(`Faucet recovery failed: ${error.message}`);
      return null;
    }
  }

  // Staff command: waive the confirmed claims of one member.
  async function reset(interaction) {
    let deferred = false;
    const answer = (content) => (deferred ? interaction.editReply({ content }) : interaction.reply(ephemeral(content)));
    try {
      if (!config.enabled) return await answer(REFUSALS.disabled());
      // Discord also hides the command from other staff, but the bot checks the permission itself.
      if (!isStaff(interaction)) return await answer('Only staff with the Manage Roles permission can reset faucet claims.');
      // Staff of another server that has the bot must not reset claims here.
      if (!interaction.guild?.channels?.cache?.has(config.channelId)) return await answer('Run /faucet-reset in the server of the faucet channel.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      deferred = true;
      const target = interaction.options.getUser('member');
      const reason = interaction.options.getString('reason');
      const result = await ledger.waiveClaims(pool, { userId: target.id, staffId: interaction.user.id, reason, now: clock() });
      if (!result.ok) {
        const nonce = result.claim.nonce === null ? 'unknown' : result.claim.nonce;
        return await answer(
          `Not reset: claim #${result.claim.id} of ${target.username} is ${result.claim.status} (nonce ${nonce}). ` +
          'Settle that claim first (see the README), then run the reset again.');
      }
      if (result.waived.length === 0) return await answer(`No confirmed claims to reset for ${target.username}.`);
      // The waive is committed: the staff answer reports it, whatever else fails.
      const count = result.waived.length;
      const claimsText = `${count} claim${count === 1 ? '' : 's'}`;
      let list = '';
      try {
        // If the unit is not ready, STK has 18 decimals.
        const unit = (await unitInTime()) || 10n ** 18n;
        const lines = result.waived.slice(0, RESET_LIST_MAX)
          .map((c) => `#${c.id} ${c.createdAt.toISOString().slice(0, 10)} ${stk(c.amount / unit)} STK`);
        if (count > RESET_LIST_MAX) lines.push(`… and ${count - RESET_LIST_MAX} more`);
        list = `${lines.join('\n')}\n`;
      } catch (error) {
        logger.error(`Faucet reset list failed: ${error.message}`);
      }
      try {
        const selfReset = target.id === interaction.user.id ? ' (self-reset)' : '';
        await post(`Faucet: ${interaction.user.username} (${interaction.user.id}) reset ${claimsText} of ${target.username} (${target.id}). Reason: ${reason || 'none given'}${selfReset}`);
      } catch (error) {
        logger.error(`Faucet reset admin post failed: ${error.message}`);
      }
      await answer(`Reset ${claimsText} of ${target.username}:\n${list}The member rules allow a new claim now. The wallet limit and the daily cap still apply.`);
    } catch (error) {
      logger.error(`Faucet reset failed: ${error.message}`);
      await answer('The reset could not be completed. Try again later.').catch(() => {});
    }
  }

  return { panel, button, submit, reset, recover };
}

module.exports = { createFaucet, waitText, BUTTON_ID, FORM_ID, ADDRESS_FIELD };
