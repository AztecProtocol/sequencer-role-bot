// Runs the real bot.js and cronJob.js without Discord and without a chain.
//
// Two boundaries are replaced, because both are external services:
//   - Discord: the client never logs in. Tests send interaction objects to the
//     real 'interactionCreate' handler and record what the bot sends back.
//   - Chain: fetchOnChainStatus answers from a table that the test controls.
// Everything else is the real code with a real database.
const path = require('node:path');
const { createEmptyDatabase } = require('./database.js');

const ROOT = path.join(__dirname, '..', '..');
const FULL_STAKE = 200000n * 10n ** 18n;
const MAINNET_ROLE = '222';
const TESTNET_ROLE = '111';

async function loadBot(serverUrl, databaseName) {
  Object.assign(process.env, {
    DATABASE_URL: await createEmptyDatabase(serverUrl, databaseName),
    DISCORD_BOT_TOKEN: 'not-a-token',
    DISCORD_GUILD_ID: '1',
    MAINNET_SEQUENCER_ROLE_ID: MAINNET_ROLE,
    TESTNET_SEQUENCER_ROLE_ID: TESTNET_ROLE,
    ADMIN_LOG_CHANNEL_ID: '333',
    AZTEC_MAINNET_RPC_URL: 'http://chain.invalid',
    AZTEC_MAINNET_REGISTRY_CONTRACT: '0x35b22e09ee0390539439e24f06da43d83f90e298',
    LOG_LEVEL: 'error'
  });
  // Empty, not deleted: dotenv would fill a deleted variable from a local .env.
  process.env.SEQUENCER_ROLE_ID = '';

  const discord = require('discord.js');
  // Record each client that the code makes. bot.js and cronJob.js make one each.
  const clients = [];
  const RealClient = discord.Client;
  discord.Client = class extends RealClient {
    constructor(options) { super(options); clients.push(this); }
    async login() { return 'ok'; }
  };
  const commandRegistrations = [];
  const commandBodies = []; // the commands of each registration
  discord.REST.prototype.put = async (route, options) => { commandRegistrations.push(route); commandBodies.push(options && options.body); return []; };

  // Chain: attester address -> 'HEALTHY' | 'SLASHED' | 'INACTIVE' (default)
  // | 'RPC_ERROR' (the read fails).
  const chain = new Map();
  const statusChecker = require(path.join(ROOT, 'statusChecker.js'));
  statusChecker.fetchOnChainStatus = async (address) => {
    const state = chain.get(address.toLowerCase()) || 'INACTIVE';
    if (state === 'RPC_ERROR') return { success: false, data: { error: 'timeout', type: 'rpc_failure' } };
    if (state === 'INACTIVE') return { success: true, data: { status: 0n, attesterView: [0n, 0n] } };
    const balance = state === 'HEALTHY' ? FULL_STAKE : FULL_STAKE - 4000n * 10n ** 18n;
    return { success: true, data: { status: 1n, attesterView: [1n, balance] } };
  };

  // Provider chain access: tests put a fake chain for each network here.
  const providerChains = new Map();
  const providerChainModule = require(path.join(ROOT, 'providers', 'chain.js'));
  providerChainModule.forNetwork = (network) => providerChains.get(String(network).toLowerCase()) || null;

  const { pool } = require(path.join(ROOT, 'db', 'db.js'));
  await require(path.join(ROOT, 'db', 'migrate.js')).migrate(pool);

  // Keep test output readable. The bot logs every step to the console.
  for (const level of ['log', 'info', 'warn', 'error']) console[level] = () => {};

  require(path.join(ROOT, 'bot.js'));
  const job = require(path.join(ROOT, 'cronJob.js'));
  const client = clients[0];

  // Discord state that the tests read.
  const roles = new Map(); // user id -> Set of role ids
  const directMessages = []; // { to, title }
  const adminMessages = []; // text of every admin-channel message
  const flags = { failRoleGrants: false, failRoleRemovals: false };
  const rolesOf = (userId) => {
    if (!roles.has(userId)) roles.set(userId, new Set());
    return roles.get(userId);
  };
  const member = (userId) => ({
    roles: {
      cache: { has: (id) => rolesOf(userId).has(id) },
      add: async (id) => {
        // true fails every grant; a role id fails only the grant of that role.
        if (flags.failRoleGrants === true || flags.failRoleGrants === id) throw new Error('Missing Permissions');
        return rolesOf(userId).add(id);
      },
      remove: async (id) => {
        // true fails every removal; a user id fails only the removals of that user.
        if (flags.failRoleRemovals === true || flags.failRoleRemovals === userId) throw new Error('Service Unavailable');
        return rolesOf(userId).delete(id);
      }
    }
  });
  const title = (payload) => {
    const embed = payload && payload.embeds && payload.embeds[0];
    return embed ? (embed.data || embed).title : payload && payload.content;
  };
  // addRole and removeRole are the REST calls that the bot uses for role changes.
  const guild = {
    id: '1',
    members: {
      fetch: async (id) => member(id),
      addRole: async ({ user, role }) => member(user).roles.add(role),
      removeRole: async ({ user, role }) => member(user).roles.remove(role)
    },
    roles: { fetch: async () => ({}) }
  };
  // All text of an answer: title, description and field names and values.
  const text = (payload) => {
    const embed = payload && payload.embeds && payload.embeds[0];
    const data = embed ? (embed.data || embed) : {};
    return [data.title, data.description, ...(data.fields || []).flatMap((f) => [f.name, f.value]), payload && payload.content]
      .filter(Boolean).join('\n');
  };
  const fakeDiscord = {
    channels: { fetch: async () => ({ send: async (payload) => { adminMessages.push(typeof payload === 'string' ? payload : (payload && payload.content) || ''); } }) },
    users: { fetch: async (id) => ({ send: async (payload) => directMessages.push({ to: id, title: title(payload), text: text(payload) }) }) },
    guilds: { fetch: async () => guild }
  };
  for (const instance of clients) {
    instance.channels.fetch = fakeDiscord.channels.fetch;
    instance.users.fetch = fakeDiscord.users.fetch;
    instance.guilds.fetch = fakeDiscord.guilds.fetch;
  }

  // Send one interaction to the bot. Returns the title or text of its last answer.
  const sentPayloads = []; // every payload that the bot sends to Discord
  async function interact(kind, customId, user, extra = {}) {
    const answers = [];
    const send = (payload) => { sentPayloads.push(payload); answers.push(payload); };
    const interaction = {
      user, member: member(user.id), guild, customId, replied: false, deferred: false,
      isChatInputCommand: () => kind === 'command',
      isStringSelectMenu: () => kind === 'select',
      isButton: () => kind === 'button',
      isModalSubmit: () => kind === 'modal',
      reply: async (payload) => send(payload),
      update: async (payload) => send(payload),
      editReply: async (payload) => send(payload),
      followUp: async (payload) => send(payload),
      deferReply: async (payload) => { if (payload) sentPayloads.push(payload); },
      showModal: async (modal) => answers.push({ content: `modal ${modal.data.custom_id}` }),
      ...extra
    };
    await Promise.all(client.listeners('interactionCreate').map((listener) => listener(interaction)));
    harness.lastAnswer = answers[answers.length - 1];
    return title(harness.lastAnswer);
  }
  const textInput = (value) => ({ fields: { getTextInputValue: () => value } });
  // A form with several named fields. A field that is not given is empty.
  const form = (values) => ({ fields: { getTextInputValue: (id) => values[id] || '' } });

  // Steps of the registration, as an operator does them in Discord.
  async function submitDetails(user, address, network = 'mainnet') {
    await interact('button', 'register_new_sequencer', user);
    await interact('select', 'network_select', user, { values: [network] });
    await interact('button', `submit_details_${network}`, user);
    return interact('modal', `registration_modal_${network}`, user, textInput(address));
  }
  async function record(user) {
    const { rows } = await pool.query(
      'SELECT * FROM pending_registrations WHERE discord_user_id = $1 ORDER BY id DESC LIMIT 1', [user.id]
    );
    return rows[0];
  }
  async function submitSignature(user, recordId, signature) {
    return interact('modal', `sig_sub_${recordId}`, user, textInput(signature));
  }
  async function register(user, wallet) {
    await submitDetails(user, wallet.address);
    const pending = await record(user);
    return submitSignature(user, pending.id, await wallet.signMessage(pending.message_to_sign));
  }
  async function reset() {
    await pool.query('TRUNCATE pending_registrations, signature_attempts, colleagues, provider_registrations, provider_attesters, event_cursors RESTART IDENTITY');
    roles.clear();
    chain.clear();
    providerChains.clear();
    directMessages.length = 0;
    adminMessages.length = 0;
    flags.failRoleGrants = false;
    flags.failRoleRemovals = false;
  }

  const harness = {
    adminMessages,
    clients,
    set failRoleGrants(value) { flags.failRoleGrants = value; },
    get failRoleGrants() { return flags.failRoleGrants; },
    set failRoleRemovals(value) { flags.failRoleRemovals = value; },
    get failRoleRemovals() { return flags.failRoleRemovals; },
    pool, chain, providerChains, job, client, commandRegistrations, commandBodies, sentPayloads, rolesOf, form, text, lastAnswer: undefined, directMessages, interact, textInput,
    submitDetails, submitSignature, register, record, reset,
    MAINNET_ROLE, TESTNET_ROLE
  };
  return harness;
}

module.exports = { loadBot };
