// Posts to the admin log channel. Shared by bot.js and cronJob.js.
// Admin posts never ping anyone: the text can carry member names.
const NO_MENTIONS = { parse: [] };

// Returns an alert function. Unlike a plain log line it throws when the post
// does not happen, so the caller can free its alert slot.
function createPostAlert(getClient) {
  return async (message) => {
    const channelId = process.env.ADMIN_LOG_CHANNEL_ID;
    if (!channelId) throw new Error('ADMIN_LOG_CHANNEL_ID is not set');
    const channel = await getClient().channels.fetch(channelId);
    if (!channel) throw new Error('the admin log channel was not found');
    await channel.send({ content: `[${new Date().toISOString()}] ${message}`, allowedMentions: NO_MENTIONS });
  };
}

module.exports = { createPostAlert, NO_MENTIONS };
