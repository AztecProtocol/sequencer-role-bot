// The member checks that run before the faucet form opens. Pure functions:
// no database and no network.
const DISCORD_EPOCH_MS = 1420070400000n;
const DAY_MS = 24 * 60 * 60 * 1000;
// Member flags AUTOMOD_QUARANTINED_USERNAME (1 << 7) and
// AUTOMOD_QUARANTINED_GUILD_TAG (1 << 10).
const QUARANTINE_FLAGS = 128 | 1024;

// A Discord id (snowflake) carries its creation time in the top 42 bits.
function accountCreatedAt(userId) {
  return new Date(Number((BigInt(userId) >> 22n) + DISCORD_EPOCH_MS));
}

// The facts the checks need, from a button or form interaction.
function memberFacts(interaction) {
  const member = interaction.member || {};
  const rawFlags = member.flags;
  return {
    userId: interaction.user.id,
    channelId: interaction.channelId,
    hasRole: (roleId) => Boolean(roleId) && Boolean(member.roles && member.roles.cache && member.roles.cache.has(roleId)),
    joinedAt: member.joinedAt || null,
    timeoutUntil: member.communicationDisabledUntil || null,
    flags: typeof rawFlags === 'number' ? rawFlags : Number((rawFlags && rawFlags.bitfield) || 0)
  };
}

function checkEligibility(facts, config, now = new Date()) {
  if (!config.enabled) return { ok: false, reason: 'disabled' };
  if (facts.channelId !== config.channelId) return { ok: false, reason: 'wrong_channel' };
  if (!facts.hasRole(config.verifiedRoleId)) return { ok: false, reason: 'not_verified' };

  const accountReady = new Date(accountCreatedAt(facts.userId).getTime() + config.minAccountDays * DAY_MS);
  if (now < accountReady) return { ok: false, reason: 'account_too_new', until: accountReady };

  if (!facts.joinedAt) return { ok: false, reason: 'server_too_new', until: null };
  const serverReady = new Date(facts.joinedAt.getTime() + config.minServerDays * DAY_MS);
  if (now < serverReady) return { ok: false, reason: 'server_too_new', until: serverReady };

  if (facts.timeoutUntil && facts.timeoutUntil > now) return { ok: false, reason: 'timed_out', until: facts.timeoutUntil };
  if (facts.flags & QUARANTINE_FLAGS) return { ok: false, reason: 'quarantined' };

  const tier = facts.hasRole(config.testnetRoleId) ? 2 : 1;
  return { ok: true, tier };
}

module.exports = { accountCreatedAt, memberFacts, checkEligibility };
