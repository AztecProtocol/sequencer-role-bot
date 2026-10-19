const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType, PermissionFlagsBits, Events, MessageFlags } = require('discord.js');
const { getEmbed, getButtons, getActionRows } = require('./utils/embedManager.js');
const dotenv = require('dotenv');
const { getPool } = require('./db/db.js');
const { keepsRole, managerNetworks } = require('./db/roleAccess.js');
const { verifyRegistrationSignature } = require('./verifySignature.js');
const { loadNetworkConfig, isNetworkConfigured, fetchOnChainStatus, determineValidatorState } = require('./statusChecker.js');
const providerChain = require('./providers/chain.js');
const { getTokenName, getDiscordRoleId } = require('./config.js');
const { canRequestSignatureAttempt, recordSignatureAttempt, generateSignatureMessage, generateSignatureTimestamp } = require('./db/signatureAttempts.js');

const { startProviderRegistration, completeProviderRegistration } = require('./providers/registration.js');

// Answers for the provider registration steps.
const PROVIDER_START_REPLIES = {
  not_configured: '❌ Provider registration is not available for this network.',
  invalid_input: '❌ Enter a numeric provider ID and a valid address.',
  no_provider: '❌ No provider with this ID exists in the staking registry.',
  not_eligible: '❌ This address is not the admin or the rewards recipient of the provider, and not an owner of a Safe in those roles.',
  in_use: 'ℹ️ You already have the role through this provider.'
};
const PROVIDER_ROLE_GRANT_FAILED = '⚠️ Your provider registration is verified, but the bot could not give the role. A server admin was told. Start the registration again after the admin fixes it.';
const PROVIDER_COMPLETE_REPLIES = {
  not_found: '❌ Registration record not found. Please start the registration again.',
  expired: '❌ This registration has expired. Please start the registration again.',
  not_configured: '❌ Provider registration is not available for this network.',
  bad_signature: '❌ Signature verification failed. Sign the exact message with the signer key.',
  not_eligible: '❌ The signer is no longer the admin or the rewards recipient of the provider.',
  inactive: '❌ The provider has no active attester, so the bot cannot give the role.',
  registry_changed: '❌ The staking registry changed. Please start the registration again.'
};
const logger = require('./utils/logger.js');

// A network is offered only when it is configured. An old button or a
// crafted id for a different network gets NETWORK_NOT_AVAILABLE.
const NETWORKS = ['mainnet', 'testnet'];
const REGISTRATION_NOT_AVAILABLE = 'Registration is not available right now.';
const NETWORK_NOT_AVAILABLE = '❌ This network is not available right now.';
const ROLE_GRANT_FAILED = '⚠️ Your registration is verified, but the bot could not give the role. A server admin was told. Start the registration again after the admin fixes it.';
const soloNetworks = () => NETWORKS.filter((network) => isNetworkConfigured(network));
const providerNetworks = () => NETWORKS.filter((network) => providerChain.forNetwork(network));

// Load environment variables
dotenv.config();

// Initialize Discord client with necessary intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
  ],
});

// Create the slash command
const registerCommand = new SlashCommandBuilder()
  .setName('register')
  .setDescription('Register as an Aztec sequencer')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);





const checkStatusNowCommand = new SlashCommandBuilder()
  .setName('check-status-now')
  .setDescription('Check your sequencer status now')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);

// Command handler
client.once(Events.ClientReady, () => {
  logger.info(`✅ Bot is ready! Logged in as ${client.user.tag}`);
  logger.info(`🤖 Bot is in ${client.guilds.cache.size} servers`);
  
  // Register slash commands
  registerCommands();
});

async function registerCommands() {
  const commands = [registerCommand, checkStatusNowCommand];
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  try {
    logger.info('🔄 Started refreshing application (/) commands.');

    if (process.env.DISCORD_GUILD_ID) {
      // Register to specific guild (faster for development)
      await rest.put(
        Routes.applicationGuildCommands(
          process.env.DISCORD_APPLICATION_ID,
          process.env.DISCORD_GUILD_ID
        ),
        { body: commands },
      );
      logger.info('✅ Successfully registered guild-specific (/) commands.');
    } else {
      // Register globally (takes up to 1 hour to propagate)
      await rest.put(
        Routes.applicationCommands(process.env.DISCORD_APPLICATION_ID),
        { body: commands },
      );
      logger.info('✅ Successfully registered global (/) commands.');
    }
  } catch (error) {
    logger.error('❌ Error registering commands:', error);
  }
}

// Get user's registration data from database (network-aware)
async function getUserRegistration(userId, network = null) {
  try {
    const pool = getPool();
    let query, params;
    
    if (network) {
      // Get registration for specific network - INCLUDE ALL STATUSES for debugging
      const networkName = network.charAt(0).toUpperCase() + network.slice(1);
      query = `
        SELECT * FROM pending_registrations 
        WHERE discord_user_id = $1 AND network = $2
        ORDER BY created_at DESC 
        LIMIT 1
      `;
      params = [userId, networkName];
    } else {
      // Get most recent registration - INCLUDE ALL STATUSES for debugging
      query = `
        SELECT * FROM pending_registrations 
        WHERE discord_user_id = $1
        ORDER BY created_at DESC 
        LIMIT 1
      `;
      params = [userId];
    }
    
    const networkName = network ? network.charAt(0).toUpperCase() + network.slice(1) : null;
    logger.info(`🔍 Querying database for user ${userId}${network ? ` on network ${networkName}` : ''}...`);
    const result = await pool.query(query, params);
    
    logger.info(`📊 Database query result: Found ${result.rows.length} registration(s)`);
    
    if (result.rows.length === 0) {
      logger.warn(`❌ No registrations found for user ${userId}${network ? ` on ${networkName}` : ''}`);
      return null;
    }
    
    const registration = result.rows[0];
    logger.info(`✅ Found registration: Status=${registration.status}, Network=${registration.network}, Wallet=${registration.wallet_address}`);
    
    // Return registration regardless of status for now (we'll check status in the calling function)
    return registration;
  } catch (error) {
    logger.error('❌ Error fetching user registration:', error.message);
    logger.error('Full error:', error);
    return null;
  }
}

// Handle Check Status Button Interaction (Network-Aware)
async function handleCheckStatusButton(interaction, network = null) {
  try {
    // Get user's registration data from database (network-aware if specified)
    const userId = interaction.user.id;
    const registration = await getUserRegistration(userId, network);
    
    if (!registration) {
      const networkText = network ? ` on ${network.charAt(0).toUpperCase() + network.slice(1)}` : '';
      return await interaction.reply({ 
        content: `You are not registered as a sequencer${networkText}.`, 
        flags: MessageFlags.Ephemeral 
      });
    }
    
    // Check if registration status allows status checking
    const allowedStatuses = ['completed', 'pending', 'at_risk', 'expired'];
    if (!allowedStatuses.includes(registration.status)) {
      const networkText = network ? ` on ${network.charAt(0).toUpperCase() + network.slice(1)}` : '';
      return await interaction.reply({ 
        content: `Your registration status (${registration.status}) does not allow status checking${networkText}.`, 
        flags: MessageFlags.Ephemeral 
      });
    }
    
    logger.info(`Checking status for ${interaction.user.username} - ${registration.status}, ${registration.network}`);

    if (!isNetworkConfigured(registration.network)) {
      return await interaction.reply({ content: NETWORK_NOT_AVAILABLE, flags: MessageFlags.Ephemeral });
    }
    
    
    // Send verification message
    const verificationEmbed = getEmbed('statusCheck.verification', {
      network: registration.network
    });
    
    await interaction.reply({
      embeds: [verificationEmbed],
      flags: MessageFlags.Ephemeral,
    });
    
    // Fetch current on-chain status
    const networkConfig = loadNetworkConfig(registration.network.toLowerCase());
    const statusResult = await fetchOnChainStatus(
      registration.wallet_address, 
      networkConfig
    );
    
    if (!statusResult.success) {
      await interaction.editReply({
        content: 'Error fetching your on-chain status. Please try again later.',
        embeds: []
      });
      return;
    }
    
    // Determine validator state using existing logic
    const validatorState = determineValidatorState(
      statusResult.data, 
      registration.network
    );
    
    // Note: DM notifications are handled by cronJob.js - no need to send duplicate DMs for manual status checks
    
    // Create dynamic status embed
    const embed = createStatusEmbed(validatorState, registration);
    
    await interaction.editReply({
      embeds: [embed],
    });
    
  } catch (error) {
    logger.error('Status check error:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ 
        content: 'Error checking your status. Please try again.', 
        embeds: [] 
      });
    } else {
      await interaction.reply({ 
        content: 'Error checking your status. Please try again.', 
        flags: MessageFlags.Ephemeral 
      });
    }
  }
}

// Create Dynamic Status Embed
function createStatusEmbed(validatorState, registration) {
  const { state, details } = validatorState;
  const tokenName = getTokenName(registration.network.toLowerCase());
  const balanceText = formatBalance(details.balance, tokenName);
  
  let embedKey;
  switch (state) {
    case 'HEALTHY':
      embedKey = 'statusCheck.report.healthy';
      break;
    case 'SLASHED':
      embedKey = 'statusCheck.report.slashed';
      break;
    case 'INACTIVE':
      embedKey = 'statusCheck.report.inactive';
      break;
    default:
      embedKey = 'statusCheck.report.unknown';
  }
  
  return getEmbed(embedKey, {
    balanceText: balanceText,
    network: registration.network
  });
}

// Format Balance Function
function formatBalance(balance, tokenName) {
  // Handle undefined, null, or invalid balance values
  if (balance === undefined || balance === null || typeof balance === 'undefined') {
    logger.warn('Invalid balance value detected:', balance, 'tokenName:', tokenName);
    return `0 ${tokenName}`;
  }
  
  // Convert BigInt to readable format
  try {
    const balanceStr = balance.toString();
    const formatted = parseInt(balanceStr) / 1e18;
    return `${formatted.toLocaleString()} ${tokenName}`;
  } catch (error) {
    logger.error('Error formatting balance:', error, 'balance:', balance);
    return `0 ${tokenName}`;
  }
}

// Create dynamic management dashboard based on user roles
function createManagementDashboard(member, hasTestnetRole, hasMainnetRole) {
  let embed, components = [];
  
  if (hasTestnetRole && !hasMainnetRole) {
    // Scenario A: Testnet Only
    embed = getEmbed('dashboard.testnet');
    
    // Only Check Status button for testnet users
    const checkStatusButton = new ButtonBuilder()
      .setCustomId('check_status_testnet')
      .setLabel('Check My Status')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📊');
    
    const row = new ActionRowBuilder()
      .addComponents(checkStatusButton);
    
    components = [row];
    
  } else if (!hasTestnetRole && hasMainnetRole) {
    // Scenario B: Mainnet Only
    embed = getEmbed('dashboard.mainnet');
    
    // Check Status and Manage Colleagues buttons for mainnet users
    const checkStatusButton = new ButtonBuilder()
      .setCustomId('check_status_mainnet')
      .setLabel('Check My Status')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📊');
    
    const manageColleaguesButton = new ButtonBuilder()
      .setCustomId('manage_colleagues')
      .setLabel('Manage Colleagues')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('👥');
    
    const row = new ActionRowBuilder()
      .addComponents(checkStatusButton, manageColleaguesButton, createRemoveColleaguesButton());
    
    components = [row];
    
  } else if (hasTestnetRole && hasMainnetRole) {
    // Scenario C: Both Testnet and Mainnet (Power User UX)
    embed = getEmbed('dashboard.mixed');
    
    // Network selection dropdown and Manage Colleagues button
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('select_status_network')
      .setPlaceholder('Select a network to check...');
    
    for (const network of soloNetworks()) {
      const name = network.charAt(0).toUpperCase() + network.slice(1);
      selectMenu.addOptions({
        label: `Check ${name} Status`,
        value: network,
        description: `Check your ${name} sequencer status`,
      });
    }
    
    const manageColleaguesButton = new ButtonBuilder()
      .setCustomId('manage_colleagues')
      .setLabel('Manage Colleagues')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('👥');
    
    const secondRow = new ActionRowBuilder()
      .addComponents(manageColleaguesButton, createRemoveColleaguesButton());
    
    // Discord refuses a select menu without options.
    components = selectMenu.options.length > 0
      ? [new ActionRowBuilder().addComponents(selectMenu), secondRow]
      : [secondRow];
  }
  
  return { embed, components };
}

// Handle manage sequencer button interaction
async function handleManageSequencerButton(interaction) {
  try {
    // Determine user's role status
    const hasTestnetRole = interaction.member.roles.cache.has(getDiscordRoleId('testnet'));
    const hasMainnetRole = interaction.member.roles.cache.has(getDiscordRoleId('mainnet'));
    
    // Create dynamic dashboard based on role status
    const { embed, components } = createManagementDashboard(
      interaction.member, 
      hasTestnetRole, 
      hasMainnetRole
    );
    
    await interaction.reply({
      embeds: [embed],
      components: components,
      flags: MessageFlags.Ephemeral,
    });
    
    logger.info(`Dashboard shown to ${interaction.user.username} - Testnet: ${hasTestnetRole}, Mainnet: ${hasMainnetRole}`);
    
  } catch (error) {
    logger.error('❌ Error handling manage sequencer button:', error);
    await interaction.followUp({
      content: 'There was an error opening the management dashboard. Please try again.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

// Create Welcome Hub Embed
function createWelcomeHubEmbed() {
  return getEmbed('registration.welcomeHub');
}

// Create Welcome Hub Action Buttons using the new Embed Manager
function createWelcomeHubButtons() {
  // NEW: Use the Embed Manager for button context editing
  // This demonstrates the new button context editing functionality
  return getButtons('registration.welcomeHub');
}

// Alternative: Create Welcome Hub Action Rows using the new Embed Manager
function createWelcomeHubActionRows() {
  // NEW: Get action rows with buttons automatically organized (max 5 per row)
  return getActionRows('registration.welcomeHub');
}

// Example: Create dynamic buttons with variable substitution
function createDynamicButtons(network) {
  // NEW: Use variables in button configurations
  // This demonstrates dynamic button context editing
  return getButtons('registration.networkSelection.submit', {
    network: network.charAt(0).toUpperCase() + network.slice(1)
  });
}

// Legacy function for backward compatibility
function createWelcomeHubButtonsLegacy() {
  const registerButton = new ButtonBuilder()
    .setCustomId('register_new_sequencer')
    .setLabel('Register as a Solo Sequencer')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('🚀');

  const manageButton = new ButtonBuilder()
    .setCustomId('manage_sequencer')
    .setLabel('Manage My Sequencer')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('⚙️');

  const learnButton = new ButtonBuilder()
    .setCustomId('what_is_sequencer')
    .setLabel('What is a Sequencer?')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('📚');

  const helpButton = new ButtonBuilder()
    .setCustomId('need_help')
    .setLabel('Need Help?')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('❓');

  return [registerButton, manageButton, learnButton, helpButton];
}

// Create Sequencer Management Dashboard Embed
function createSequencerManagementDashboard() {
  return getEmbed('dashboard.general');
}

// Create Management Dashboard Buttons
function createManagementButtons() {
  const checkStatusButton = new ButtonBuilder()
    .setCustomId('check_status')
    .setLabel('Check My Status')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('📊');

  const manageColleaguesButton = new ButtonBuilder()
    .setCustomId('manage_colleagues')
    .setLabel('Manage Colleagues')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('👥');

  return [checkStatusButton, manageColleaguesButton];
}

// Create Network Selection Embed
function createNetworkSelectionEmbed() {
  return getEmbed('registration.networkSelection');
}

// Create Network Select Menu
function createNetworkSelectMenu(networks) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('network_select')
    .setPlaceholder('Select a network...');

  // Add network options
  networks.forEach(network => {
    selectMenu.addOptions({
      label: network.charAt(0).toUpperCase() + network.slice(1),
      value: network,
      description: `Register as a sequencer on ${network}`,
    });
  });

  return selectMenu;
}

// Create Cancel Button
function createCancelButton() {
  return new ButtonBuilder()
    .setCustomId('cancel_registration')
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Danger);
}

// Create Input Embed for Step 2
function createInputEmbed(selectedNetwork) {
  return getEmbed('registration.inputDetails', {
    network: selectedNetwork.charAt(0).toUpperCase() + selectedNetwork.slice(1)
  });
}

// Create Submit Details Button
function createSubmitDetailsButton(network) {
  return new ButtonBuilder()
    .setCustomId(`submit_details_${network}`)
    .setLabel('Submit Details')
    .setStyle(ButtonStyle.Primary);
}

// Create Registration Modal
function createRegistrationModal(network) {
  return new ModalBuilder()
    .setCustomId(`registration_modal_${network}`)
    .setTitle(`Registration Details - ${network.charAt(0).toUpperCase() + network.slice(1)}`);
}

// Create Wallet Address Text Input
function createWalletAddressInput() {
  return new TextInputBuilder()
    .setCustomId('wallet_address')
    .setLabel('Wallet Address')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Enter your wallet address')
    .setRequired(true);
}



// Create Signature Embed (Step 9)
function createSignatureEmbed(messageToSign, recordId) {
  return getEmbed('registration.signature', {
    messageToSign: messageToSign
  });
}

// Create Signature Modal (Step 10)
function createSignatureModal(recordId) {
  return new ModalBuilder()
    .setCustomId(`sig_sub_${recordId}`)
    .setTitle('Submit Signature');
}

// Create Signature Text Input
function createSignatureInput() {
  return new TextInputBuilder()
    .setCustomId('signature')
    .setLabel('Signature Hash')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Enter the signature hash (0x...')
    .setRequired(true);
}

// Create the button that opens the form to remove colleagues
function createRemoveColleaguesButton() {
  return new ButtonBuilder()
    .setCustomId('remove_colleagues')
    .setLabel('Remove Colleagues')
    .setStyle(ButtonStyle.Danger);
}

// Create the form to remove colleagues, with the same five ID fields
function createRemoveColleaguesModal() {
  const modal = new ModalBuilder()
    .setCustomId('remove_colleagues_modal')
    .setTitle('Remove Sequencer Colleagues');
  const inputs = [createDiscordIdInput1(), createDiscordIdInput2(), createDiscordIdInput3(), createDiscordIdInput4(), createDiscordIdInput5()];
  modal.addComponents(...inputs.map((input) => new ActionRowBuilder().addComponents(input)));
  return modal;
}

// Text for the status command: the registration state and the next action
function registrationStateText(registration) {
  switch (registration.status) {
    case 'completed':
      return 'You have the role.';
    case 'at_risk': {
      if (!registration.at_risk_since) {
        return 'Your attester is inactive. Your role is removed after seven days of inactivity.';
      }
      const removalTime = Math.floor(new Date(registration.at_risk_since).getTime() / 1000) + 7 * 24 * 60 * 60;
      return `Your attester is inactive. Your role is removed on <t:${removalTime}:D> if the attester stays inactive.`;
    }
    case 'removed':
      return 'Your role was removed. Register again to get it back.';
    default:
      return 'Your registration is not complete. Register to get the role.';
  }
}

// Create Colleague Management Modal
function createColleagueManagementModal() {
  return new ModalBuilder()
    .setCustomId('manage_colleagues_modal')
    .setTitle('Manage Your Sequencer Colleagues');
}

// Create Discord ID Input Fields
function createDiscordIdInput1() {
  return new TextInputBuilder()
    .setCustomId('discord_id_1')
    .setLabel('User ID #1')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('123456789012345678')
    .setRequired(false);
}

function createDiscordIdInput2() {
  return new TextInputBuilder()
    .setCustomId('discord_id_2')
    .setLabel('User ID #2')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Optional')
    .setRequired(false);
}

function createDiscordIdInput3() {
  return new TextInputBuilder()
    .setCustomId('discord_id_3')
    .setLabel('User ID #3')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Optional')
    .setRequired(false);
}

function createDiscordIdInput4() {
  return new TextInputBuilder()
    .setCustomId('discord_id_4')
    .setLabel('User ID #4')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Optional')
    .setRequired(false);
}

function createDiscordIdInput5() {
  return new TextInputBuilder()
    .setCustomId('discord_id_5')
    .setLabel('User ID #5')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Optional')
    .setRequired(false);
}

// Create Submit Signature Button
function createSubmitSignatureButton(recordId) {
  return new ButtonBuilder()
    .setCustomId(`submit_signature_${recordId}`)
    .setLabel('Submit Signature')
    .setStyle(ButtonStyle.Success);
}

// Give the network role of a solo registration. Returns null, or the error
// text when the role id is not configured or Discord refuses the grant.
// The failure goes to the admin channel.
async function grantSoloRole(interaction, network) {
  const roleId = getDiscordRoleId(network.toLowerCase());
  let grantError = roleId ? null : 'no role id configured';
  if (roleId) {
    try {
      await interaction.member.roles.add(roleId);
    } catch (error) {
      grantError = error.message;
    }
  }
  if (grantError) {
    await logToAdminChannel(`⚠️ Role grant failed for registration: ${interaction.user.username} (${interaction.user.id}) - ${network} - ${grantError}`);
  }
  return grantError;
}

// A completed registration whose member has no role (for example after a
// failed grant) gets the role on the next attempt. Only 'completed': a
// registration at risk keeps a role it has, but does not get a removed role
// back. Returns true when it answered the interaction.
async function restoreCompletedRole(interaction, networkName, answer) {
  const { rows } = await getPool().query(
    `SELECT id FROM pending_registrations
     WHERE discord_user_id = $1 AND network = $2 AND status = 'completed' LIMIT 1`,
    [interaction.user.id, networkName]
  );
  const roleId = getDiscordRoleId(networkName.toLowerCase());
  if (rows.length === 0 || (roleId && interaction.member.roles.cache.has(roleId))) return false;
  if (await grantSoloRole(interaction, networkName)) {
    await answer({ content: ROLE_GRANT_FAILED, embeds: [], components: [] });
    return true;
  }
  await answer({ embeds: [getEmbed('registrationProcess.success')], components: [] });
  await logToAdminChannel(`Role restored for ${interaction.user.username} (${interaction.user.id}) on ${networkName} - role assigned`);
  return true;
}

// Only an operator or provider with an own completed mainnet registration
// manages colleagues. A colleague has the role too, but no registration.
async function managesColleagues(userId) {
  return (await managerNetworks(getPool(), userId)).includes('Mainnet');
}
const MAX_COLLEAGUES = 10;

// Give a colleague each network role of the manager that the colleague does
// not have yet. Returns the number of those roles the colleague now holds and
// the networks whose grant failed ({ network, error }).
async function grantColleagueRoles(guild, managerId, colleagueId) {
  const result = { held: 0, failed: [] };
  const networks = await managerNetworks(getPool(), managerId);
  let member;
  try {
    member = await guild.members.fetch(colleagueId);
  } catch (error) {
    result.failed = networks.map((network) => ({ network, error: error.message }));
    return result;
  }
  for (const network of networks) {
    const roleId = getDiscordRoleId(network.toLowerCase());
    if (!roleId) {
      result.failed.push({ network, error: 'no role id configured' });
      continue;
    }
    if (member.roles.cache.has(roleId)) {
      result.held += 1;
      continue;
    }
    try {
      await member.roles.add(roleId);
      result.held += 1;
    } catch (error) {
      result.failed.push({ network, error: error.message });
    }
  }
  return result;
}
// A Discord user id (snowflake), the same for the add and the remove form.
const DISCORD_ID_PATTERN = /^\d{17,20}$/;

// Log to Admin Channel
async function logToAdminChannel(message) {
  try {
    const adminChannelId = process.env.ADMIN_LOG_CHANNEL_ID;
    if (!adminChannelId) {
      logger.warn('ADMIN_LOG_CHANNEL_ID not set, skipping admin log');
      return;
    }
    
    const channel = await client.channels.fetch(adminChannelId);
    if (channel) {
      const timestamp = new Date().toISOString();
      await channel.send(`[${timestamp}] ${message}`);
    }
  } catch (error) {
    logger.error('❌ Error logging to admin channel:', error);
  }
}

// Handle slash command interactions
client.on('interactionCreate', async (interaction) => {
  // Handle slash commands
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'register') {
      try {
        // Send Welcome Hub Embed with 4 Action Buttons
        const embed = createWelcomeHubEmbed();
        const buttons = createWelcomeHubButtons();
        
        // Split buttons into two rows (max 5 buttons per row, we'll use 2 rows for 4 buttons)
        const firstRow = new ActionRowBuilder()
          .addComponents(buttons[0], buttons[1], buttons[2]);
        const secondRow = new ActionRowBuilder()
          .addComponents(buttons[3], buttons[4]);

        await interaction.reply({
          embeds: [embed],
          components: [firstRow, secondRow]
        });
        
        console.log(`Welcome hub sent to ${interaction.user.username}`);
        
      } catch (error) {
        console.error('❌ Error handling register command:', error);
        await interaction.reply({
          content: 'There was an error starting the registration process. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }


    } else if (interaction.commandName === 'check-status-now') {
      try {
        // Force immediate status check with DM notification
        const userId = interaction.user.id;
        const registration = await getUserRegistration(userId);
        
        if (!registration) {
          return await interaction.reply({ 
            content: 'You are not registered as a sequencer.', 
            flags: MessageFlags.Ephemeral 
          });
        }
        
        if (!isNetworkConfigured(registration.network)) {
          return await interaction.reply({ content: NETWORK_NOT_AVAILABLE, flags: MessageFlags.Ephemeral });
        }

        // Send initial response
        const processingEmbed = getEmbed('statusCheck.forceInit');
        
        await interaction.reply({
          embeds: [processingEmbed],
          flags: MessageFlags.Ephemeral,
        });
        
        // Perform immediate status check (without DM notifications - handled by cronJob.js)
        const networkConfig = loadNetworkConfig(registration.network.toLowerCase());
        const statusResult = await fetchOnChainStatus(registration.wallet_address, networkConfig);
        
        if (!statusResult.success) {
          await interaction.editReply({
            content: 'Error fetching your on-chain status. Please try again later.',
            embeds: []
          });
          return;
        }
        
        // Determine validator state using existing logic
        const validatorState = determineValidatorState(statusResult.data, registration.network);
        
        const resultEmbed = getEmbed('statusCheck.forceComplete', {
          state: validatorState.state,
          network: registration.network
        });
        resultEmbed.addFields({ name: 'Registration', value: registrationStateText(registration) });
        
        await interaction.editReply({
          embeds: [resultEmbed],
        });
        
        console.log(`⚡ Force status check completed for ${interaction.user.username} - State: ${validatorState.state}`);
        
      } catch (error) {
        console.error('❌ Error handling check-status-now command:', error);
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content: 'There was an error performing the force status check. Please try again.',
            embeds: [],
          });
        } else {
          await interaction.reply({
            content: 'There was an error performing the force status check. Please try again.',
            flags: MessageFlags.Ephemeral,
          });
        }
      }
    }
  }
  
  // Handle message component interactions (dropdowns and buttons)
  else if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'network_select') {
      const selectedNetwork = interaction.values[0];
      
      try {
        if (!soloNetworks().includes(selectedNetwork)) {
          await interaction.update({ content: NETWORK_NOT_AVAILABLE, embeds: [], components: [] });
          return;
        }

        // Check for existing registrations on this network
        const pool = getPool();
        const roleId = getDiscordRoleId(selectedNetwork);
        
        // Check if user already has this specific network role
        if (roleId && interaction.member.roles.cache.has(roleId)) {
          const alreadyRegisteredEmbed = getEmbed('registration.alreadyRegistered', {
            network: selectedNetwork.charAt(0).toUpperCase() + selectedNetwork.slice(1)
          });
          
          await interaction.update({
            embeds: [alreadyRegisteredEmbed],
            components: [],
          });
          
          console.log(`Existing ${selectedNetwork} sequencer detected for user ${interaction.user.username} (${interaction.user.id}) - redirected to management`);
          return;
        }
        
        const networkName = selectedNetwork.charAt(0).toUpperCase() + selectedNetwork.slice(1);
        if (await restoreCompletedRole(interaction, networkName, (payload) => interaction.update(payload))) return;

        // Also check database for existing completed registration on this network
        const existingRegistrationQuery = `
          SELECT id, status FROM pending_registrations 
          WHERE discord_user_id = $1 AND network = $2 AND status = 'completed'
          ORDER BY created_at DESC 
          LIMIT 1
        `;
        
        const existingResult = await pool.query(existingRegistrationQuery, [interaction.user.id, selectedNetwork.charAt(0).toUpperCase() + selectedNetwork.slice(1)]);
        
        if (existingResult.rows.length > 0) {
          const alreadyRegisteredEmbed = getEmbed('registration.alreadyRegisteredCompleted', {
            network: selectedNetwork.charAt(0).toUpperCase() + selectedNetwork.slice(1)
          });
          
          await interaction.update({
            embeds: [alreadyRegisteredEmbed],
            components: [],
          });
          
          console.log(`Existing ${selectedNetwork} registration found in database for user ${interaction.user.username} (${interaction.user.id}) - redirected to management`);
          return;
        }
        
        // Continue with normal flow if no existing registration found
        const embed = createInputEmbed(selectedNetwork);
        const submitButton = createSubmitDetailsButton(selectedNetwork);
        const cancelButton = createCancelButton();
        const row = new ActionRowBuilder()
          .addComponents(submitButton, cancelButton);

        await interaction.update({
          embeds: [embed],
          components: [row],
        });
      } catch (error) {
        console.error('❌ Error handling network selection:', error);
        await interaction.followUp({
          content: 'There was an error processing your selection. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
    
    else if (interaction.customId === 'select_status_network') {
      // Handle network selection for status checking
      const selectedNetwork = interaction.values[0];
      
      try {
        await handleCheckStatusButton(interaction, selectedNetwork);
        
        console.log(`Network-specific status check triggered for ${interaction.user.username} (${interaction.user.id}) - Network: ${selectedNetwork}`);
      } catch (error) {
        console.error('❌ Error handling network status selection:', error);
        await interaction.followUp({
          content: 'There was an error checking your status. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
    else if (interaction.customId === 'provider_network_select') {
      try {
        const network = interaction.values[0];
        if (!providerNetworks().includes(network)) {
          await interaction.reply({ content: PROVIDER_START_REPLIES.not_configured, flags: MessageFlags.Ephemeral });
          return;
        }
        const modal = new ModalBuilder()
          .setCustomId(`provider_details_modal_${network}`)
          .setTitle(`Provider Registration - ${network === 'mainnet' ? 'Mainnet' : 'Testnet'}`)
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder()
              .setCustomId('provider_id')
              .setLabel('Provider ID (from the staking dashboard)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('e.g. 1')
              .setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder()
              .setCustomId('signer_address')
              .setLabel('Admin or rewards recipient address')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('0x...')
              .setRequired(true))
          );
        await interaction.showModal(modal);
      } catch (error) {
        console.error('❌ Error opening the provider details form:', error);
      }
    }
  }
  
  // Handle message component interactions (buttons)
  else if (interaction.isButton()) {
    if (interaction.customId === 'cancel_registration') {
      try {
        await interaction.update({
          content: 'Registration cancelled.',
          embeds: [],
          components: [],
        });
      } catch (error) {
        console.error('❌ Error handling cancel button:', error);
      }
    }
    
    else if (interaction.customId === 'register_new_sequencer') {
      try {
        // Check for existing registrations
        // We'll check for existing registrations after network selection
        // For now, allow the flow to continue to network selection
        console.log(`Starting registration flow for ${interaction.user.username}`);
        
        // Start registration flow
        // CRITICAL FIX: Use ephemeral response instead of update() to preserve public embed
        const networks = soloNetworks();
        if (networks.length === 0) {
          await interaction.reply({ content: REGISTRATION_NOT_AVAILABLE, flags: MessageFlags.Ephemeral });
          return;
        }
        const embed = createNetworkSelectionEmbed();
        const selectMenu = createNetworkSelectMenu(networks);
        const cancelButton = createCancelButton();
        
        const firstRow = new ActionRowBuilder()
          .addComponents(selectMenu);
        const secondRow = new ActionRowBuilder()
          .addComponents(cancelButton);

        await interaction.reply({
          embeds: [embed],
          components: [firstRow, secondRow],
          flags: MessageFlags.Ephemeral  // This ensures the public embed remains visible to all users
        });
        
        console.log(`Registration flow started for ${interaction.user.username}`);
      } catch (error) {
        console.error('❌ Error handling register new sequencer button:', error);
        await interaction.followUp({
          content: 'There was an error starting the registration process. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
    
    else if (interaction.customId === 'manage_sequencer') {
      try {
        // Check if user has sequencer role
        // Check if user has any sequencer role (testnet, mainnet, or legacy)
        const roleIds = {
          testnet: getDiscordRoleId('testnet'),
          mainnet: getDiscordRoleId('mainnet'),
          legacy: process.env.SEQUENCER_ROLE_ID
        };
        
        const hasAnySequencerRole = (
          (roleIds.testnet && interaction.member.roles.cache.has(roleIds.testnet)) ||
          (roleIds.mainnet && interaction.member.roles.cache.has(roleIds.mainnet)) ||
          (roleIds.legacy && interaction.member.roles.cache.has(roleIds.legacy))
        );
        
        if (!hasAnySequencerRole) {
          // User does NOT have any sequencer role - redirect to registration
          const notRegisteredEmbed = getEmbed('registration.required');
          
          await interaction.reply({
            embeds: [notRegisteredEmbed],
            flags: MessageFlags.Ephemeral,
          });
          
          console.log(`Non-sequencer attempted access: ${interaction.user.username} - redirected`);
          return;
        }
        
        // User has sequencer role - show dynamic management dashboard
        await handleManageSequencerButton(interaction);
        
      } catch (error) {
        console.error('❌ Error handling manage sequencer button:', error);
        await interaction.followUp({
          content: 'There was an error opening the management dashboard. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
    
    else if (interaction.customId === 'check_status') {
      try {
        // Legacy handler for backward compatibility - calls network-aware version
        await handleCheckStatusButton(interaction);
      } catch (error) {
        console.error('❌ Error handling check status button:', error);
      }
    }
    
    else if (interaction.customId === 'check_status_testnet') {
      try {
        // Testnet-specific status check
        await handleCheckStatusButton(interaction, 'testnet');
      } catch (error) {
        console.error('❌ Error handling testnet status button:', error);
      }
    }
    
    else if (interaction.customId === 'check_status_mainnet') {
      try {
        // Mainnet-specific status check
        await handleCheckStatusButton(interaction, 'mainnet');
      } catch (error) {
        console.error('❌ Error handling mainnet status button:', error);
      }
    }
    
    else if (interaction.customId === 'manage_colleagues') {
      try {
        // The user must have an own completed mainnet registration.
        if (!(await managesColleagues(interaction.user.id))) {
          const accessDeniedEmbed = getEmbed('errors.accessDenied');
          
          await interaction.reply({
            embeds: [accessDeniedEmbed],
            flags: MessageFlags.Ephemeral,
          });
          
          console.log(`🚫 Colleagues management access denied - own Mainnet registration required for user ${interaction.user.username} (${interaction.user.id})`);
          return;
        }
        
        // Show the colleague management modal
        const modal = createColleagueManagementModal();
        const discordIdInput1 = createDiscordIdInput1();
        const discordIdInput2 = createDiscordIdInput2();
        const discordIdInput3 = createDiscordIdInput3();
        const discordIdInput4 = createDiscordIdInput4();
        const discordIdInput5 = createDiscordIdInput5();
        
        // Create action rows for the modal - one input per row to avoid width issues
        const firstRow = new ActionRowBuilder().addComponents(discordIdInput1);
        const secondRow = new ActionRowBuilder().addComponents(discordIdInput2);
        const thirdRow = new ActionRowBuilder().addComponents(discordIdInput3);
        const fourthRow = new ActionRowBuilder().addComponents(discordIdInput4);
        const fifthRow = new ActionRowBuilder().addComponents(discordIdInput5);
        
        // Add all rows to the modal
        modal.addComponents(firstRow, secondRow, thirdRow, fourthRow, fifthRow);
        
        await interaction.showModal(modal);
        
        console.log(`Colleague management modal shown to ${interaction.user.username}`);
      } catch (error) {
        console.error('❌ Error handling manage colleagues button:', error);
        await interaction.followUp({
          content: 'There was an error opening the colleague management modal. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
    
    else if (interaction.customId === 'remove_colleagues') {
      try {
        if (!(await managesColleagues(interaction.user.id))) {
          await interaction.reply({
            embeds: [getEmbed('errors.accessDenied')],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.showModal(createRemoveColleaguesModal());
      } catch (error) {
        console.error('❌ Error opening the remove colleagues form:', error);
        await interaction.followUp({
          content: 'There was an error opening the form. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
    else if (interaction.customId === 'register_provider') {
      try {
        const networks = providerNetworks();
        if (networks.length === 0) {
          await interaction.reply({ content: REGISTRATION_NOT_AVAILABLE, flags: MessageFlags.Ephemeral });
          return;
        }
        const select = new StringSelectMenuBuilder()
          .setCustomId('provider_network_select')
          .setPlaceholder('Select the network of your provider')
          .addOptions(networks.map((network) => ({ label: network === 'mainnet' ? 'Mainnet' : 'Testnet', value: network })));
        await interaction.reply({
          content: 'Select the network of your provider.',
          components: [new ActionRowBuilder().addComponents(select)],
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        console.error('❌ Error starting provider registration:', error);
      }
    }
    else if (interaction.customId.startsWith('provider_submit_signature_')) {
      try {
        const recordId = interaction.customId.replace('provider_submit_signature_', '');
        const modal = new ModalBuilder()
          .setCustomId(`provider_sig_sub_${recordId}`)
          .setTitle('Submit Signature')
          .addComponents(new ActionRowBuilder().addComponents(createSignatureInput()));
        await interaction.showModal(modal);
      } catch (error) {
        console.error('❌ Error opening the provider signature form:', error);
      }
    }
    else if (interaction.customId.startsWith('submit_details_')) {
      const network = interaction.customId.replace('submit_details_', '');
      
      try {
        if (!soloNetworks().includes(network)) {
          await interaction.reply({ content: NETWORK_NOT_AVAILABLE, flags: MessageFlags.Ephemeral });
          return;
        }
        const modal = createRegistrationModal(network);
        const walletInput = createWalletAddressInput();
        
        const actionRow = new ActionRowBuilder().addComponents(walletInput);
        
        modal.addComponents(actionRow);
        
        await interaction.showModal(modal);
      } catch (error) {
        console.error('❌ Error showing modal:', error);
        await interaction.followUp({
          content: 'There was an error opening the registration form. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
    
    else if (interaction.customId.startsWith('submit_signature_')) {
      const recordId = interaction.customId.replace('submit_signature_', '');
      
      try {
        console.log(`Signature button clicked: ${recordId}`);
        
        // Validate recordId
        if (!recordId) {
          throw new Error('Invalid record ID');
        }
        
        // Show signature modal (Step 10)
        // Create signature modal
        
        const signatureInput = createSignatureInput();
        console.log('SignatureInput created:', signatureInput);
        console.log('SignatureInput type:', typeof signatureInput);
        console.log('SignatureInput constructor:', signatureInput.constructor.name);
        
        const actionRow = new ActionRowBuilder().addComponents(signatureInput);
        console.log('ActionRow created:', actionRow);
        console.log('ActionRow type:', typeof actionRow);
        console.log('ActionRow constructor:', actionRow.constructor.name);
        console.log('ActionRow components:', actionRow.components);
        
        const modal = new ModalBuilder()
          .setCustomId(`sig_sub_${recordId}`)
          .setTitle('Submit Signature')
          .addComponents(actionRow);
        
        console.log('Modal after construction:', modal);
        console.log('Modal components after construction:', modal.components);
        
        // AGGRESSIVE DEBUGGING: Print entire modal object before showing
        console.log('🚨 AGGRESSIVE DEBUG: Complete modal object structure:');
        try {
          console.log('Modal type:', typeof modal);
          console.log('Modal constructor:', modal.constructor.name);
          console.log('Modal data:', modal.data);
          console.log('Modal customId:', modal.data?.custom_id);
          console.log('Modal title:', modal.data?.title);
          console.log('Modal components (modal.components):', modal.components);
          console.log('Modal components (modal.data.components):', modal.data?.components);
          if (modal.components && modal.components.length > 0) {
            console.log('SUCCESS: Modal has components!');
            console.log('Components array length:', modal.components.length);
            modal.components.forEach((component, index) => {
              console.log(`Component ${index}:`, component);
            });
          } else {
            console.log('❌ CRITICAL: Modal components are still undefined or empty!');
          }
        } catch (debugError) {
          console.error('❌ Debug logging error:', debugError);
        }
        
        console.log('Modal created successfully, showing to user');
        console.log(`Modal customId: ${modal.data.custom_id}`);
        console.log(`Modal title: ${modal.data.title}`);
        await interaction.showModal(modal);
        console.log('Modal shown successfully');
      } catch (error) {
        console.error('❌ Error showing signature modal:', error);
        
        // Ensure we always respond to prevent "This interaction failed"
        try {
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
              content: 'There was an error opening the signature form. Please try again.',
              flags: MessageFlags.Ephemeral,
            });
          } else {
            await interaction.reply({
              content: 'There was an error opening the signature form. Please try again.',
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch (followUpError) {
          console.error('❌ Failed to send error message:', followUpError);
        }
      }
    }
    
    else if (interaction.customId === 'what_is_sequencer') {
      try {
        const sequencerInfoEmbed = getEmbed('info.whatIsSequencer');
        
        await interaction.reply({
          embeds: [sequencerInfoEmbed],
          flags: MessageFlags.Ephemeral,
        });
        
        console.log(`Sent sequencer info to ${interaction.user.username}`);
      } catch (error) {
        console.error('❌ Error handling what_is_sequencer button:', error);
        await interaction.reply({
          content: 'There was an error loading sequencer information. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
    
    else if (interaction.customId === 'need_help') {
      try {
        const helpEmbed = getEmbed('info.needHelp');
        
        await interaction.reply({
          embeds: [helpEmbed],
          flags: MessageFlags.Ephemeral,
        });
        
        console.log(`Sent help info to ${interaction.user.username}`);
      } catch (error) {
        console.error('❌ Error handling need_help button:', error);
        await interaction.reply({
          content: 'There was an error loading help information. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  }
  
  // Handle modal submissions (Steps 8-10)
  else if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('registration_modal_')) {
      const network = interaction.customId.replace('registration_modal_', '');
      
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!soloNetworks().includes(network)) {
          await interaction.editReply({ content: NETWORK_NOT_AVAILABLE });
          return;
        }

        // Extract wallet address from modal submission
        const walletAddress = interaction.fields.getTextInputValue('wallet_address').trim();
        const networkName = network.charAt(0).toUpperCase() + network.slice(1);

        // A registration in use keeps its attester. Without this check, an open
        // details form could replace the attester with no signature.
        const inUse = await getPool().query(
          `SELECT id FROM pending_registrations
           WHERE discord_user_id = $1 AND network = $2 AND status IN ('completed', 'at_risk')`,
          [interaction.user.id, networkName]
        );
        if (inUse.rows.length > 0) {
          if (await restoreCompletedRole(interaction, networkName, (payload) => interaction.editReply(payload))) return;
          await interaction.editReply({
            embeds: [getEmbed('registration.alreadyRegisteredCompleted', { network: networkName })],
          });
          return;
        }
        
        // Generate timestamped message to sign (Step 8) - Updated for signature attempt tracking
        const messageToSign = generateSignatureMessage(interaction.user.id, walletAddress);
        const timestamp = parseInt(messageToSign.match(/Timestamp: (\d+)/)[1]);
        
        // Check if user can request signature attempt for this network
        const canRequest = await canRequestSignatureAttempt(
          interaction.user.id,
          interaction.user.username,
          network,
          walletAddress,
          timestamp
        );
        
        if (!canRequest.success) {
          await interaction.editReply({
            content: canRequest.message,
          });
          return;
        }
        
        // Record the signature attempt
        const recordResult = await recordSignatureAttempt(
          interaction.user.id,
          interaction.user.username,
          network,
          walletAddress,
          timestamp
        );
        
        if (!recordResult.success) {
          console.error('Failed to record signature attempt:', recordResult.error);
        }
        
        // Get database pool and implement smart upsert for pending registration (Step 8)
        const pool = getPool();
        
        // Check if user has a pending registration for this network - if so, update it instead of creating new
        const pendingQuery = `
          SELECT id, wallet_address FROM pending_registrations 
          WHERE discord_user_id = $1 AND network = $2 AND status = 'pending'
          ORDER BY created_at DESC 
          LIMIT 1
        `;
        
        const pendingResult = await pool.query(pendingQuery, [interaction.user.id, network.charAt(0).toUpperCase() + network.slice(1)]);
        
        let recordId;
        
        if (pendingResult.rows.length > 0) {
          // Update existing pending registration
          const existing = pendingResult.rows[0];
          const updateQuery = `
            UPDATE pending_registrations 
            SET wallet_address = $1, message_to_sign = $2, expires_at = NOW() + INTERVAL '24 hours'
            WHERE id = $3
            RETURNING id
          `;
          
          const updateResult = await pool.query(updateQuery, [walletAddress, messageToSign, existing.id]);
          recordId = updateResult.rows[0].id;
          
          console.log(`🔄 Updated existing pending registration ${recordId} for user ${interaction.user.username} (${interaction.user.id})`);
        } else {
          // Create new pending registration with proper error handling for unique constraint
          const insertQuery = `
            INSERT INTO pending_registrations (
              discord_user_id, 
              discord_username, 
              network, 
              wallet_address, 
              message_to_sign, 
              expires_at
            ) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '24 hours')
            RETURNING id
          `;
          
          const values = [
            interaction.user.id,
            interaction.user.username,
            network.charAt(0).toUpperCase() + network.slice(1),
            walletAddress,
            messageToSign
          ];
          
          try {
            const insertResult = await pool.query(insertQuery, values);
            recordId = insertResult.rows[0].id;
            console.log(`Created new registration ${recordId} for ${interaction.user.username}`);
          } catch (insertError) {
            // Handle unique constraint violation by updating existing record
            if (insertError.code === '23505') {
              console.log(`Unique constraint violation for ${interaction.user.username} on ${network}`);
              
              // Find and update the existing record
              const existingQuery = `
                SELECT id FROM pending_registrations 
                WHERE discord_user_id = $1 AND network = $2
                ORDER BY created_at DESC 
                LIMIT 1
              `;
              
              const existingResult = await pool.query(existingQuery, [interaction.user.id, network.charAt(0).toUpperCase() + network.slice(1)]);
              
              if (existingResult.rows.length > 0) {
                // The existing record is expired, removed or cancelled. Start it again.
                const updateQuery = `
                  UPDATE pending_registrations 
                  SET wallet_address = $1, message_to_sign = $2, expires_at = NOW() + INTERVAL '24 hours',
                      status = 'pending', signature = NULL, updated_at = NOW(),
                      at_risk_since = NULL, last_notification_status = NULL
                  WHERE id = $3
                  RETURNING id
                `;
                
                const updateResult = await pool.query(updateQuery, [walletAddress, messageToSign, existingResult.rows[0].id]);
                recordId = updateResult.rows[0].id;
                
                console.log(`Updated registration ${recordId} for ${interaction.user.username}`);
              } else {
                throw new Error('Could not find existing record to update');
              }
            } else {
              throw insertError;
            }
          }
        }
        
        // Create Signature Embed with message and Submit Signature button (Step 9)
        const signatureEmbed = createSignatureEmbed(messageToSign, recordId);
        const submitButton = createSubmitSignatureButton(recordId);
        const row = new ActionRowBuilder()
          .addComponents(submitButton);
        
        // Respond with Signature Embed (Step 9)
        await interaction.editReply({
          embeds: [signatureEmbed],
          components: [row],
        });
        
        console.log(`Created registration record ${recordId} for ${interaction.user.username}`);
        
      } catch (error) {
        console.error('❌ Error handling modal submission:', error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
                content: 'There was an error processing your registration details. Please try again.',
            });
        } else {
            await interaction.reply({
                content: 'There was an error processing your registration details. Please try again.',
                flags: MessageFlags.Ephemeral,
            });
        }
      }
    }
    
    else if (interaction.customId.startsWith('sig_sub_')) {
      // Handle signature modal submission (Steps 11-12)
      const recordId = interaction.customId.replace('sig_sub_', '');
      
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Extract signature from modal submission
        const signature = interaction.fields.getTextInputValue('signature');
        
        // Retrieve registration record from database (handle all non-completed states)
        const pool = getPool();
        const selectQuery = `
          SELECT id, discord_user_id, discord_username, network, wallet_address, message_to_sign, status, expires_at
          FROM pending_registrations
          WHERE id = $1 AND discord_user_id = $2 AND status IN ('pending', 'active', 'in_progress', 'cancelled')
        `;
        
        const result = await pool.query(selectQuery, [recordId, interaction.user.id]);
        
        if (result.rows.length === 0) {
          // Try to find any record for this user to provide better error message
          const anyRecordQuery = `
            SELECT id, status FROM pending_registrations 
            WHERE discord_user_id = $1 AND network = (SELECT network FROM pending_registrations WHERE id = $2 LIMIT 1)
            ORDER BY created_at DESC 
            LIMIT 1
          `;
          
          const anyResult = await pool.query(anyRecordQuery, [interaction.user.id, recordId]);
          
          if (anyResult.rows.length > 0) {
            const anyRecord = anyResult.rows[0];
            if (anyRecord.status === 'completed') {
              await interaction.editReply({
                content: '❌ This registration has already been completed. Please use the "Manage My Sequencer" options instead.',
              });
            } else if (anyRecord.status === 'expired') {
              await interaction.editReply({
                content: '❌ This registration has expired. Please start the registration process again.',
              });
            } else {
              await interaction.editReply({
                content: '❌ Registration record not found or already processed.',
              });
            }
          } else {
            await interaction.editReply({
              content: '❌ Registration record not found. Please start the registration process again.',
            });
          }
          return;
        }
        
        const record = result.rows[0];

        if (!isNetworkConfigured(record.network)) {
          await interaction.editReply({ content: NETWORK_NOT_AVAILABLE });
          return;
        }
        
        // If record is cancelled, reactivate it to pending for signature retry
        if (record.status === 'cancelled') {
          console.log(`Reactivating cancelled record ${recordId}`);
          
          // Try to update with updated_at column, fall back to basic update if column doesn't exist
          try {
            const reactivateQuery = `
              UPDATE pending_registrations 
              SET status = 'pending', updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND discord_user_id = $2
            `;
            
            await pool.query(reactivateQuery, [recordId, interaction.user.id]);
          } catch (updateError) {
            // Fall back to basic update if updated_at column doesn't exist
            const basicReactivateQuery = `
              UPDATE pending_registrations 
              SET status = 'pending'
              WHERE id = $1 AND discord_user_id = $2
            `;
            
            await pool.query(basicReactivateQuery, [recordId, interaction.user.id]);
            console.log(`Using basic update for reactivation`);
          }
          
          // Update the record object to reflect the new status
          record.status = 'pending';
          
          console.log(`Reactivated record ${recordId} for ${interaction.user.username}`);
        }
        
        // Check if record has expired
        if (new Date(record.expires_at) < new Date()) {
          try {
            await pool.query('UPDATE pending_registrations SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', ['expired', recordId]);
          } catch (dbError) {
            // Fall back to basic update if updated_at column doesn't exist
            await pool.query('UPDATE pending_registrations SET status = $1 WHERE id = $2', ['expired', recordId]);
          }
          await interaction.editReply({
            content: '❌ Registration has expired. Please start the process again.',
          });
          return;
        }
        
        // Signature Validation (Step 11)
        
        const verificationResult = await verifyRegistrationSignature(record, signature, interaction.user.id);
        
        console.log('Signature verification result:');
        console.log('Verification result:', verificationResult);
        
        if (!verificationResult.success) {
          // Update database record status to cancelled
          try {
            await pool.query('UPDATE pending_registrations SET signature = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [signature, 'cancelled', recordId]);
          } catch (dbError) {
            // Fall back to basic update if updated_at column doesn't exist
            await pool.query('UPDATE pending_registrations SET signature = $1, status = $2 WHERE id = $3', [signature, 'cancelled', recordId]);
          }
          
          // Send failure embed
          const failureEmbed = getEmbed('registrationProcess.failure');
          
          await interaction.editReply({
            embeds: [failureEmbed],
          });
          
          // Log to admin channel
          await logToAdminChannel(`❌ Registration failed for ${interaction.user.username} (${interaction.user.id}) - Invalid signature`);
          return;
        }
        
        // On-Chain Status Check and Validation (Step 11) with intelligent status handling
        const networkConfig = loadNetworkConfig(record.network.toLowerCase());
        
        // Send initial verification message
        const verificationEmbed = getEmbed('registrationProcess.verificationRequest');
        
        await interaction.editReply({
          embeds: [verificationEmbed],
        });
        
        let statusResult;
        let retryAttempts = 0;
        const maxRetries = 2;
        
        // Retry logic for RPC failures
        while (retryAttempts <= maxRetries) {
          try {
            console.log(`RPC check attempt ${retryAttempts + 1}/${maxRetries + 1} for ${record.wallet_address}`);
            
            statusResult = await fetchOnChainStatus(record.wallet_address, networkConfig);
            
            if (statusResult.success) {
              console.log(`RPC Status check successful on attempt ${retryAttempts + 1}`);
              break;
            } else {
              throw new Error(`RPC call failed: ${statusResult.data.error}`);
            }
          } catch (error) {
            retryAttempts++;
            console.warn(`RPC attempt ${retryAttempts} failed:`, error.message);
            
            if (retryAttempts <= maxRetries) {
              console.log(`Retrying in ${retryAttempts * 2} seconds...`);
              await new Promise(resolve => setTimeout(resolve, retryAttempts * 2000));
              
              // Update user about retry
              const retryEmbed = getEmbed('registrationProcess.retryVerification', {
                retryAttempts: retryAttempts,
                maxRetries: maxRetries
              });
              
              await interaction.editReply({
                embeds: [retryEmbed],
              });
            }
          }
        }
        
        // Handle RPC failure after all retries exhausted
        if (!statusResult || !statusResult.success) {
          console.error(`RPC failure for ${record.wallet_address} after ${retryAttempts} attempts`);
          
          // Try to update with enhanced fields, fall back to basic if columns don't exist
          try {
            await pool.query(
              'UPDATE pending_registrations SET signature = $1, status = $2, retry_count = $3, last_error = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5',
              [signature, 'rpc_failed', retryAttempts, statusResult?.data?.error || 'Unknown RPC error', recordId]
            );
          } catch (dbError) {
            // Fall back to basic update if enhanced columns don't exist
            console.warn('Using basic database update');
            await pool.query(
              'UPDATE pending_registrations SET signature = $1, status = $2 WHERE id = $3',
              [signature, 'rpc_failed', recordId]
            );
          }
          
          // Send RPC failure embed
          const rpcFailureEmbed = getEmbed('registrationProcess.rpcFailure');
          
          await interaction.editReply({
            embeds: [rpcFailureEmbed],
          });
          
          // Log RPC failure to admin channel
          await logToAdminChannel(`⏳ RPC failure for ${interaction.user.username} (${interaction.user.id}) on ${record.network} - the chain read did not finish after ${retryAttempts} attempts. The user was told to start the registration again.`);
          return;
        }
        
        // Get on-chain status and determine validator state
        const validatorState = determineValidatorState(statusResult.data, record.network.toLowerCase());
        console.log(`Validator state: ${validatorState.state} for ${record.wallet_address}`);
        
        // Handle different states according to the Definitive On-Chain Rulebook
        if (validatorState.state === 'INACTIVE') {
          console.log(`INACTIVE validator: ${record.wallet_address}`);
          
          // Update database record status to cancelled
          try {
            await pool.query('UPDATE pending_registrations SET signature = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [signature, 'cancelled', recordId]);
          } catch (dbError) {
            // Fall back to basic update if updated_at column doesn't exist
            await pool.query('UPDATE pending_registrations SET signature = $1, status = $2 WHERE id = $3', [signature, 'cancelled', recordId]);
          }
          
          // Send failure embed for INACTIVE users
          const tokenName = getTokenName(record.network.toLowerCase());
          const failureEmbed = getEmbed('registrationProcess.inactiveValidator', {
            tokenName: tokenName
          });
          
          await interaction.editReply({
            embeds: [failureEmbed],
          });
          
          // Log to admin channel
          await logToAdminChannel(`❌ Registration failed for ${interaction.user.username} (${interaction.user.id}) - INACTIVE validator status`);
          return;
        }
        
        // For HEALTHY or SLASHED users - registration succeeds
        let successMessage = 'Registration successful!';
        let isSlashed = false;
        
        if (validatorState.state === 'SLASHED') {
          isSlashed = true;
          const tokenName = getTokenName(record.network.toLowerCase());
          successMessage = `Registration successful! P.S. We noticed your on-chain stake is partially reduced. We recommend checking your node's performance.`;
          console.log(`SLASHED validator (registration allowed): ${record.wallet_address}`);
        }
        
        // Success - Update database record status to completed
        try {
          await pool.query('UPDATE pending_registrations SET signature = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [signature, 'completed', recordId]);
        } catch (dbError) {
          // Fall back to basic update if updated_at column doesn't exist
          await pool.query('UPDATE pending_registrations SET signature = $1, status = $2 WHERE id = $3', [signature, 'completed', recordId]);
        }
        
        // The record stays 'completed'. A failed grant is repaired on the next
        // attempt (see restoreCompletedRole).
        if (await grantSoloRole(interaction, record.network)) {
          await interaction.editReply({ content: ROLE_GRANT_FAILED, embeds: [] });
          return;
        }
        console.log(`Assigned ${record.network} role to ${interaction.user.username}`);
        
        // Send success embed with intelligent messaging
        const successEmbed = getEmbed('registrationProcess.success');
        
        await interaction.editReply({
          embeds: [successEmbed],
        });
        
        // Log to admin channel with detailed information
        const adminLogMessage = `Registration completed for ${interaction.user.username} (${interaction.user.id}) - ` +
          `Sequencer role assigned - Validator State: ${validatorState.state}` +
          (isSlashed ? ` - Stake: ${validatorState.details.balance}/${validatorState.details.fullStake}` : '');
        await logToAdminChannel(adminLogMessage);
        
        console.log(`Registration completed for ${interaction.user.username}`);
        
      } catch (error) {
        console.error('❌ Error handling signature modal submission:', error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
                content: 'There was an error processing your signature. Please try again.',
            });
        } else {
            await interaction.reply({
                content: 'There was an error processing your signature. Please try again.',
                flags: MessageFlags.Ephemeral,
            });
        }
      }
    }
    
    else if (interaction.customId.startsWith('provider_details_modal_')) {
      const network = interaction.customId.replace('provider_details_modal_', '');
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const providerId = interaction.fields.getTextInputValue('provider_id').trim();
        const signer = interaction.fields.getTextInputValue('signer_address').trim();
        const timestamp = generateSignatureTimestamp();

        const canRequest = await canRequestSignatureAttempt(interaction.user.id, interaction.user.username, network, signer, timestamp);
        if (!canRequest.success) {
          await interaction.editReply({ content: canRequest.message });
          return;
        }
        // Each start counts against the rate limit, also a start that fails.
        await recordSignatureAttempt(interaction.user.id, interaction.user.username, network, signer, timestamp);

        const result = await startProviderRegistration(getPool(), {
          discordUserId: interaction.user.id,
          discordUsername: interaction.user.username,
          network,
          providerId,
          signer
        });
        if (!result.ok) {
          // Repair the role only for a completed registration. A registration
          // at risk keeps a role it has, but does not get a removed role back.
          const inUseRoleId = result.reason === 'in_use' && result.status === 'completed' ? getDiscordRoleId(network) : null;
          if (inUseRoleId && !interaction.member.roles.cache.has(inUseRoleId)) {
            // The registration is complete but the member lacks the role: repair it now.
            try {
              await interaction.member.roles.add(inUseRoleId);
            } catch (error) {
              await logToAdminChannel(`⚠️ Role grant failed for provider registration: ${interaction.user.username} (${interaction.user.id}) - provider ${providerId} on ${network} - ${error.message}`);
              await interaction.editReply({ content: PROVIDER_ROLE_GRANT_FAILED });
              return;
            }
            await interaction.editReply({ embeds: [getEmbed('registrationProcess.success')] });
            await logToAdminChannel(`Provider role restored for ${interaction.user.username} (${interaction.user.id}) - provider ${providerId} on ${network} - role assigned`);
            return;
          }
          await interaction.editReply({ content: PROVIDER_START_REPLIES[result.reason] });
          return;
        }

        const submit = new ButtonBuilder()
          .setCustomId(`provider_submit_signature_${result.recordId}`)
          .setLabel('Submit Signature')
          .setStyle(ButtonStyle.Primary);
        await interaction.editReply({
          embeds: [getEmbed('registration.signature', { messageToSign: result.message })],
          components: [new ActionRowBuilder().addComponents(submit)],
        });
      } catch (error) {
        console.error('❌ Error in the provider details step:', error);
        await interaction.editReply({ content: 'There was an error processing your provider details. Please try again.' });
      }
    }
    else if (interaction.customId.startsWith('provider_sig_sub_')) {
      const recordId = interaction.customId.replace('provider_sig_sub_', '');
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const signature = interaction.fields.getTextInputValue('signature').trim();
        const result = await completeProviderRegistration(getPool(), {
          recordId,
          discordUserId: interaction.user.id,
          signature
        });
        if (!result.ok) {
          await interaction.editReply({ content: PROVIDER_COMPLETE_REPLIES[result.reason] });
          await logToAdminChannel(`❌ Provider registration failed for ${interaction.user.username} (${interaction.user.id}) - ${result.reason}`);
          return;
        }
        const roleId = getDiscordRoleId(result.network);
        let grantError = roleId ? null : 'no role id configured';
        if (roleId) {
          try {
            await interaction.member.roles.add(roleId);
          } catch (error) {
            grantError = error.message;
          }
        }
        if (grantError) {
          await logToAdminChannel(`⚠️ Role grant failed for provider registration: ${interaction.user.username} (${interaction.user.id}) - provider ${result.providerId} on ${result.network} - ${grantError}`);
          await interaction.editReply({ content: PROVIDER_ROLE_GRANT_FAILED });
          return;
        }
        await interaction.editReply({ embeds: [getEmbed('registrationProcess.success')] });
        await logToAdminChannel(`Provider registration completed for ${interaction.user.username} (${interaction.user.id}) - provider ${result.providerId} on ${result.network} - role assigned`);
      } catch (error) {
        console.error('❌ Error in the provider signature step:', error);
        await interaction.editReply({ content: 'There was an error checking your signature. Please try again.' });
      }
    }
    else if (interaction.customId === 'remove_colleagues_modal') {
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!(await managesColleagues(interaction.user.id))) {
          await interaction.editReply({ embeds: [getEmbed('errors.accessDenied')] });
          return;
        }
        const pool = getPool();
        const ids = [1, 2, 3, 4, 5]
          .map((n) => interaction.fields.getTextInputValue(`discord_id_${n}`).trim())
          .filter((id) => id !== '');

        const invalidIds = ids.filter((id) => !DISCORD_ID_PATTERN.test(id));
        if (invalidIds.length > 0) {
          await interaction.editReply({ content: `❌ Invalid Discord ID format: ${invalidIds.join(', ')}` });
          return;
        }
        if (ids.length === 0) {
          await interaction.editReply({ content: '⚠️ Please enter at least one Discord User ID.' });
          return;
        }

        const removed = [];
        const notFound = [];
        for (const colleagueId of ids) {
          // Only a colleague of the submitting operator can be removed.
          const result = await pool.query(
            `UPDATE colleagues SET status = 'removed', updated_at = NOW()
             WHERE manager_discord_id = $1 AND colleague_user_id = $2 AND status <> 'removed'
             RETURNING colleague_username`,
            [interaction.user.id, colleagueId]
          );
          if (result.rows.length === 0) {
            notFound.push(colleagueId);
            continue;
          }
          removed.push(result.rows[0].colleague_username || colleagueId);

          // Remove each network role that the colleague no longer has through a different path.
          try {
            const member = await interaction.guild.members.fetch(colleagueId);
            for (const network of ['testnet', 'mainnet']) {
              const roleId = getDiscordRoleId(network);
              if (roleId && member.roles.cache.has(roleId) && !(await keepsRole(pool, colleagueId, network))) {
                await member.roles.remove(roleId);
              }
            }
          } catch (roleError) {
            console.warn(`Could not remove the role of colleague ${colleagueId}:`, roleError.message);
          }
        }

        const lines = [];
        if (removed.length) lines.push(`✅ Removed: ${removed.join(', ')}`);
        if (notFound.length) lines.push(`ℹ️ Not one of your colleagues: ${notFound.join(', ')}`);
        await interaction.editReply({ content: lines.join('\n') });
        await logToAdminChannel(`Colleagues removed by ${interaction.user.username} (${interaction.user.id}): ${removed.join(', ') || 'none'}`);
      } catch (error) {
        console.error('❌ Error removing colleagues:', error);
        await interaction.editReply({ content: 'There was an error removing the colleagues. Please try again.' });
      }
    }
    else if (interaction.customId === 'manage_colleagues_modal') {
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!(await managesColleagues(interaction.user.id))) {
          await interaction.editReply({ embeds: [getEmbed('errors.accessDenied')] });
          return;
        }
        
        // Phase 3.3: Implement Smart Upsert Logic
        const pool = getPool();
        
        // Extract Discord IDs from modal submission
        const discordId1 = interaction.fields.getTextInputValue('discord_id_1');
        const discordId2 = interaction.fields.getTextInputValue('discord_id_2');
        const discordId3 = interaction.fields.getTextInputValue('discord_id_3');
        const discordId4 = interaction.fields.getTextInputValue('discord_id_4');
        const discordId5 = interaction.fields.getTextInputValue('discord_id_5');
        
        // Filter out empty Discord IDs
        const discordIds = [discordId1, discordId2, discordId3, discordId4, discordId5]
          .filter(id => id && id.trim() !== '');
        
        // Validate Discord IDs format
        const invalidIds = discordIds.filter(id => !DISCORD_ID_PATTERN.test(id.trim()));
        
        if (invalidIds.length > 0) {
          await interaction.editReply({
            content: `❌ Invalid Discord ID format detected. Discord IDs should be 17-20 digits. Invalid IDs: ${invalidIds.join(', ')}`
          });
          return;
        }
        
        if (discordIds.length === 0) {
          await interaction.editReply({
            content: '⚠️ Please enter at least one Discord User ID to manage colleagues.'
          });
          return;
        }
        
        // At most MAX_COLLEAGUES active colleagues. An id that is already an
        // active colleague does not count again. Refuse the whole submission.
        const { rows: activeRows } = await pool.query(
          "SELECT colleague_user_id FROM colleagues WHERE manager_discord_id = $1 AND status = 'active'",
          [interaction.user.id]
        );
        const active = new Set(activeRows.map((row) => row.colleague_user_id));
        const newIds = new Set(discordIds.map((id) => id.trim()).filter((id) => !active.has(id)));
        if (active.size + newIds.size > MAX_COLLEAGUES) {
          await interaction.editReply({ content: `❌ You can have at most ${MAX_COLLEAGUES} colleagues. Remove one first.` });
          return;
        }
        
        // Smart Upsert Processing
        const upsertResults = {
          added: [],
          reactivated: [],
          alreadyActive: [],
          errors: [],
          rolesGranted: 0,
          failedGrants: [] // { colleagueId, network, error } for each role a colleague misses
        };
        
        const managerId = interaction.user.id;
        const managerUsername = interaction.user.username;
        
        console.log(`Starting upsert for manager ${managerUsername}`);

        // Give the colleague the missing roles. Each role that the colleague
        // still misses afterwards counts as a failed grant.
        const giveRoles = async (colleagueId) => {
          const { held, failed } = await grantColleagueRoles(interaction.guild, managerId, colleagueId);
          upsertResults.rolesGranted += held;
          for (const { network, error } of failed) upsertResults.failedGrants.push({ colleagueId, network, error });
        };
        
        // Process each colleague Discord ID
        for (const colleagueId of discordIds) {
          try {
            // Get or fetch colleague username
            let colleagueUsername = `user_${colleagueId.slice(-6)}`; // Fallback
            
            try {
              const guild = await interaction.guild;
              const colleagueMember = await guild.members.fetch(colleagueId);
              colleagueUsername = colleagueMember.user.username;
            } catch (fetchError) {
              console.warn(`⚠️ Could not fetch username for ${colleagueId}, using fallback`);
            }
            
            // Check if relationship already exists
            const existingQuery = `
              SELECT id, status, colleague_username 
              FROM colleagues 
              WHERE manager_discord_id = $1 AND colleague_user_id = $2
            `;
            
            const existingResult = await pool.query(existingQuery, [managerId, colleagueId]);
            
            if (existingResult.rows.length > 0) {
              const existing = existingResult.rows[0];
              
              if (existing.status === 'inactive' || existing.status === 'removed') {
                // Reactivate inactive colleague
                const updateQuery = `
                  UPDATE colleagues 
                  SET status = 'active', updated_at = NOW() 
                  WHERE id = $1 
                  RETURNING *
                `;
                
                await pool.query(updateQuery, [existing.id]);
                upsertResults.reactivated.push({
                  id: colleagueId,
                  username: existing.colleague_username || colleagueUsername,
                  action: 're-activated'
                });
                
                await giveRoles(colleagueId);
                
                console.log(`Re-activated colleague ${existing.colleague_username || colleagueUsername}`);
                
              } else {
                // Already active. The colleague can still miss a role, for
                // example after the manager lost the role and registered again.
                await giveRoles(colleagueId);
                upsertResults.alreadyActive.push({
                  id: colleagueId,
                  username: existing.colleague_username || colleagueUsername,
                  action: 'already active'
                });
                
                console.log(`Colleague ${existing.colleague_username || colleagueUsername} already active`);
              }
              
            } else {
              // New colleague - insert new record
              const insertQuery = `
                INSERT INTO colleagues (manager_discord_id, manager_username, colleague_user_id, colleague_username, status)
                VALUES ($1, $2, $3, $4, 'active')
                RETURNING *
              `;
              
              await pool.query(insertQuery, [managerId, managerUsername, colleagueId, colleagueUsername]);
              upsertResults.added.push({
                id: colleagueId,
                username: colleagueUsername,
                action: 'added'
              });
              
              await giveRoles(colleagueId);
              
              console.log(`Added colleague ${colleagueUsername}`);
            }
            
          } catch (colleagueError) {
            console.error(`❌ Error processing colleague ${colleagueId}:`, colleagueError);
            upsertResults.errors.push({
              id: colleagueId,
              error: colleagueError.message
            });
          }
        }
        
        // Generate comprehensive success summary
        const totalProcessed = upsertResults.added.length + upsertResults.reactivated.length + upsertResults.alreadyActive.length;
        const totalErrors = upsertResults.errors.length;
        
        const successEmbed = getEmbed('management.colleagueSuccess');
        
        if (totalErrors > 0) {
          successEmbed.addFields({
            name: '⚠️ Errors',
            value: `${totalErrors} colleague(s) could not be processed`,
            inline: false
          });
        }
        
        // A colleague who misses a role of the manager: the grant failed
        // (the manager has a completed registration, see managesColleagues).
        for (const { colleagueId, network, error } of upsertResults.failedGrants) {
          await logToAdminChannel(`⚠️ Role grant failed for colleague ${colleagueId} of ${managerUsername} (${managerId}) on ${network}: ${error}`);
        }
        if (upsertResults.failedGrants.length > 0) {
          await interaction.editReply({ content: 'Colleague saved, but the bot could not give the role. A server admin was told.' });
        } else {
          await interaction.editReply({
            embeds: [successEmbed]
          });
        }
        
        // Comprehensive Admin Logging
        const logMessage = `Colleague Management for ${interaction.user.username}:\n` +
          `• Added: ${upsertResults.added.length} colleague(s)\n` +
          `• Re-activated: ${upsertResults.reactivated.length} colleague(s)\n` +
          `• Already Active: ${upsertResults.alreadyActive.length} colleague(s)\n` +
          `• Roles Granted: ${upsertResults.rolesGranted} role(s)\n` +
          `• Errors: ${totalErrors} error(s)\n` +
          `• Total Processed: ${totalProcessed}/${discordIds.length} colleague(s)`;
        
        await logToAdminChannel(logMessage);
        
        // Detailed logging for each action
        upsertResults.added.forEach(colleague => {
          console.log(`📝 Sequencer \`${managerUsername}\` has **added** colleague \`${colleague.username}\``);
        });
        
        upsertResults.reactivated.forEach(colleague => {
          console.log(`📝 Sequencer \`${managerUsername}\` has **re-activated** colleague \`${colleague.username}\``);
        });
        
        upsertResults.alreadyActive.forEach(colleague => {
          console.log(`📝 Sequencer \`${managerUsername}\` - colleague \`${colleague.username}\` already active (no action needed)`);
        });
        
        console.log(`Upsert completed for ${managerUsername}: ${totalProcessed} processed, ${totalErrors} errors`);
        
      } catch (error) {
        console.error('❌ Error handling colleague management modal submission:', error);
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content: 'There was an error processing your colleague data. Please try again.',
          });
        } else {
          await interaction.reply({
            content: 'There was an error processing your colleague data. Please try again.',
            flags: MessageFlags.Ephemeral,
          });
        }
        
        // Log error to admin channel
        await logToAdminChannel(`❌ Colleague management error for ${interaction.user.username} (${interaction.user.id}): ${error.message}`);
      }
    }
  }
});

// Handle errors
client.on('error', error => {
  console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', error => {
  console.error('❌ Unhandled promise rejection:', error);
});

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
  console.error('❌ Failed to login to Discord:', error);
  process.exit(1);
});
