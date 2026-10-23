const test = require('node:test');
const assert = require('node:assert/strict');
const { GatewayIntentBits, IntentsBitField } = require('discord.js');
const { loadBot } = require('./helpers/discordHarness.js');

// Needs a disposable Postgres (see README).
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';

// The bot reacts only to its own interactions and changes roles through
// REST, so it subscribes to no member or message events. Server
// Members is a privileged intent that Discord reviews for large servers.
test('each bot client asks only for the Guilds intent', { skip }, async (t) => {
  const bot = await loadBot(url, 'bot_intents');
  t.after(() => bot.pool.end());

  assert.ok(bot.clients.length >= 2, 'the bot and the status job each make a client');
  for (const client of bot.clients) {
    const intents = new IntentsBitField(client.options.intents);
    assert.deepEqual(intents.toArray(), ['Guilds']);
    assert.equal(intents.has(GatewayIntentBits.GuildMembers), false);
  }
});
