const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('discord.js');
const { grantRole, removeRole } = require('../utils/memberRoles.js');

// The real discord.js guild and member classes, with the REST API replaced.
// The bot asks for no member events, so a member that the client stored
// earlier can hold old roles. Role changes must reach Discord anyway.
function setup() {
  const client = new Client({ intents: [] });
  const calls = [];
  const failures = new Map(); // 'PUT' | 'DELETE' -> error
  for (const method of ['get', 'put', 'delete', 'patch', 'post']) {
    client.rest[method] = async (route) => {
      calls.push([method.toUpperCase(), route]);
      if (failures.has(method.toUpperCase())) throw failures.get(method.toUpperCase());
      return {};
    };
  }
  const guild = client.guilds._add({ id: '1', name: 'test', roles: [], channels: [], members: [], emojis: [], stickers: [] });
  const storeMember = (roles) => guild.members._add({ user: { id: '42', username: 'operator' }, roles, joined_at: '2026-01-01T00:00:00Z' });
  return { client, guild, calls, failures, storeMember };
}

test('a removal reaches Discord when the stored member shows no role', async (t) => {
  const { client, guild, calls, storeMember } = setup();
  t.after(() => client.destroy());
  storeMember([]); // stored before the role was granted elsewhere

  assert.equal(await removeRole(guild, '42', '222'), null);
  assert.deepEqual(calls, [['DELETE', '/guilds/1/members/42/roles/222']]);
});

test('a grant reaches Discord when the stored member already shows the role', async (t) => {
  const { client, guild, calls, storeMember } = setup();
  t.after(() => client.destroy());
  storeMember(['222']); // stored before the role was removed elsewhere

  await grantRole(guild, '42', '222');
  assert.deepEqual(calls, [['PUT', '/guilds/1/members/42/roles/222']]);
});

test('a grant and then a removal in one process both reach Discord', async (t) => {
  const { client, guild, calls } = setup();
  t.after(() => client.destroy());

  await grantRole(guild, '42', '222');
  assert.equal(await removeRole(guild, '42', '222'), null);
  assert.deepEqual(calls.map(([method]) => method), ['PUT', 'DELETE']);
});

test('a removal for a user who left the server counts as done', async (t) => {
  const { client, guild, failures } = setup();
  t.after(() => client.destroy());
  failures.set('DELETE', Object.assign(new Error('Unknown Member'), { code: 10007 }));

  assert.equal(await removeRole(guild, '42', '222'), null);
});

test('a refused removal returns the error text', async (t) => {
  const { client, guild, failures } = setup();
  t.after(() => client.destroy());
  failures.set('DELETE', Object.assign(new Error('Missing Permissions'), { code: 50013 }));

  assert.equal(await removeRole(guild, '42', '222'), 'Missing Permissions');
});

test('a refused grant throws', async (t) => {
  const { client, guild, failures } = setup();
  t.after(() => client.destroy());
  failures.set('PUT', Object.assign(new Error('Missing Permissions'), { code: 50013 }));

  await assert.rejects(grantRole(guild, '42', '222'), /Missing Permissions/);
});
