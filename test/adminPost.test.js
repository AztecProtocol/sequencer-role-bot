const test = require('node:test');
const assert = require('node:assert/strict');
const { createPostAlert } = require('../utils/adminPost.js');

function withChannelId(t, value) {
  const before = process.env.ADMIN_LOG_CHANNEL_ID;
  process.env.ADMIN_LOG_CHANNEL_ID = value;
  t.after(() => { process.env.ADMIN_LOG_CHANNEL_ID = before; });
}

test('an alert goes to the admin channel with a timestamp and no mentions', async (t) => {
  withChannelId(t, '333');
  const sent = [];
  const fetched = [];
  const client = { channels: { fetch: async (id) => { fetched.push(id); return { send: async (payload) => { sent.push(payload); } }; } } };
  await createPostAlert(() => client)('@everyone low balance');
  assert.deepEqual(fetched, ['333']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] @everyone low balance$/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('an alert that cannot be posted throws', async (t) => {
  withChannelId(t, '');
  const client = { channels: { fetch: async () => ({ send: async () => {} }) } };
  await assert.rejects(createPostAlert(() => client)('x'), /ADMIN_LOG_CHANNEL_ID/);
  process.env.ADMIN_LOG_CHANNEL_ID = '333';
  await assert.rejects(createPostAlert(() => ({ channels: { fetch: async () => null } }))('x'), /not found/);
  const failing = { channels: { fetch: async () => ({ send: async () => { throw new Error('discord down'); } }) } };
  await assert.rejects(createPostAlert(() => failing)('x'), /discord down/);
});
