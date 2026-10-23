// Role changes that go straight to the Discord REST API.
//
// The bot asks only for the Guilds intent, so it receives no member events
// and a member that discord.js stored earlier can show old roles. These
// helpers never read that stored member: Discord accepts a grant of a role
// that the member has and a removal of a role that the member does not have.

// Discord error code for a member who is not in the server.
const UNKNOWN_MEMBER = 10007;

// Give a role. Throws when Discord refuses it.
async function grantRole(guild, userId, roleId) {
  await guild.members.addRole({ user: userId, role: roleId });
}

// Remove a role. Returns null when the role is gone (removed now, the member
// did not have it, or the member is not in the server), else the error text.
async function removeRole(guild, userId, roleId) {
  try {
    await guild.members.removeRole({ user: userId, role: roleId });
    return null;
  } catch (error) {
    if (error.code === UNKNOWN_MEMBER) return null;
    return error.message || String(error);
  }
}

module.exports = { grantRole, removeRole, UNKNOWN_MEMBER };
