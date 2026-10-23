#!/usr/bin/env node

const { Client, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');
const { getPool } = require('./db/db.js');
const { keepsRole, managerNetworks } = require('./db/roleAccess.js');
const providerChain = require('./providers/chain.js');
const { eligibleSignerKind } = require('./providers/signers.js');
const { syncProviderAttesters, isProviderActive } = require('./providers/attesterIndex.js');
const { fetchOnChainStatus, determineValidatorState } = require('./statusChecker.js');
const { onCanonicalChange } = require('./rollupResolver.js');
const { getDiscordRoleId, getTokenName } = require('./config.js');
const { getEmbed } = require('./utils/embedManager.js');
const { formatEther } = require('ethers');
const dotenv = require('dotenv');
const cron = require('node-cron');
const logger = require('./utils/logger.js');
const memberRoles = require('./utils/memberRoles.js');

// Load environment variables
dotenv.config();

// Initialize Discord client for DM operations
const discordClient = new Client({
  // Only Guilds: the bot reacts to its own interactions and changes roles
  // through REST (utils/memberRoles.js), so it needs no member or message events.
  // Server Members is a privileged intent that Discord reviews for large apps.
  intents: [GatewayIntentBits.Guilds]
});

// A network upgrade changes the canonical rollup. Only the status job posts
// it (not bot.js), so the admin channel gets one message.
onCanonicalChange((network, from, to) => logToAdminChannel(
  `ℹ️ The canonical rollup for ${network} changed from ${from} to ${to}. Attesters that stay on the old rollup now read as inactive and follow the normal 7-day path.`
));

// Send Critical DM for INACTIVE users
// A stake in wei as a readable amount, for example "196,000 AZTEC".
function formatStake(wei, network) {
  const amount = Number(formatEther(BigInt(wei)));
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${getTokenName(String(network).toLowerCase())}`;
}

async function sendCriticalDM(discordUserId, walletAddress, network) {
  try {
    const user = await discordClient.users.fetch(discordUserId);
    
    const embed = getEmbed('notifications.critical', {
      walletAddress: walletAddress,
      network: network
    });

    await user.send({ embeds: [embed] });
    logger.info(`Critical DM sent to ${discordUserId}`);
  } catch (error) {
    logger.error(`Failed to send DM to ${discordUserId}:`, error.message);
  }
}

// Send Warning DM for SLASHED users
async function sendWarningDM(discordUserId, walletAddress, currentBalance, fullStake, network) {
  try {
    const user = await discordClient.users.fetch(discordUserId);
    
    const embed = getEmbed('notifications.warning', {
      walletAddress: walletAddress,
      network: network,
      currentBalance: `\`${formatStake(currentBalance, network)}\``,
      expectedBalance: `\`${formatStake(fullStake, network)}\``
    });

    await user.send({ embeds: [embed] });
    logger.info(`Warning DM sent to ${discordUserId}`);
  } catch (error) {
    logger.error(`Failed to send warning DM to ${discordUserId}:`, error.message);
  }
}

// Send Safe DM for HEALTHY users
async function sendSafeDM(discordUserId, walletAddress, network) {
  try {
    const user = await discordClient.users.fetch(discordUserId);
    
    const embed = getEmbed('notifications.safe', {
      walletAddress: walletAddress,
      network: network
    });

    await user.send({ embeds: [embed] });
    logger.info(`Safe DM sent to ${discordUserId}`);
  } catch (error) {
    logger.error(`Failed to send safe DM to ${discordUserId}:`, error.message);
  }
}

// Send Warning Embed for status changes
async function sendWarningEmbed(discordUserId, walletAddress, currentStatus) {
  try {
    const user = await discordClient.users.fetch(discordUserId);
    
    const embed = getEmbed('notifications.legacyWarning', {
      walletAddress: walletAddress,
      currentStatus: currentStatus
    });

    await user.send({ embeds: [embed] });
    logger.info(`Warning DM sent to ${discordUserId}`);
  } catch (error) {
    logger.error(`Failed to send warning DM to ${discordUserId}:`, error.message);
  }
}

// Send All Clear Embed
async function sendAllClearEmbed(discordUserId, walletAddress) {
  try {
    const user = await discordClient.users.fetch(discordUserId);
    
    const embed = getEmbed('notifications.legacyAllClear', {
      walletAddress: walletAddress
    });

    await user.send({ embeds: [embed] });
    logger.info(`All Clear DM sent to ${discordUserId}`);
  } catch (error) {
    logger.error(`Failed to send all clear DM to ${discordUserId}:`, error.message);
  }
}

// Send Removal Notification
async function sendRemovalEmbed(discordUserId, walletAddress, network) {
  try {
    const user = await discordClient.users.fetch(discordUserId);
    
    const embed = getEmbed('notifications.removal', {
      walletAddress: walletAddress,
      network: network
    });

    await user.send({ embeds: [embed] });
    logger.info(`Removal DM sent to ${discordUserId}`);
  } catch (error) {
    logger.error(`Failed to send removal DM to ${discordUserId}:`, error.message);
  }
}

// Remove a role. Returns null when the role is gone (removed now, the member
// does not have it, or the member is not in the server), else the error text.
async function tryRemoveSequencerRole(discordUserId, roleId) {
  let error;
  try {
    const guild = await discordClient.guilds.fetch(process.env.DISCORD_GUILD_ID);
    error = await memberRoles.removeRole(guild, discordUserId, roleId);
  } catch (fetchError) {
    error = fetchError.message || String(fetchError);
  }
  if (error) {
    logger.error(`Failed to remove role from ${discordUserId}:`, error);
    return error;
  }
  logger.info(`Role removed from ${discordUserId} (or not held)`);
  return null;
}

// Returns true when the role is gone, false on any other error.
async function removeSequencerRole(discordUserId, roleId) {
  return (await tryRemoveSequencerRole(discordUserId, roleId)) === null;
}

// Post a message to the admin log channel. A failure is only logged.
async function logToAdminChannel(message) {
  try {
    const channelId = process.env.ADMIN_LOG_CHANNEL_ID;
    if (!channelId) return;
    const channel = await discordClient.channels.fetch(channelId);
    if (channel) await channel.send(`[${new Date().toISOString()}] ${message}`);
  } catch (error) {
    logger.error('Failed to post to the admin channel:', error.message);
  }
}

// A removal that Discord refused: the registration goes back to 'at_risk'
// with its old at_risk_since, so the next run tries again.
async function reportFailedRemoval(pool, table, id, username, userId, network, error) {
  await pool.query(`UPDATE ${table} SET status = 'at_risk' WHERE id = $1`, [id]);
  await logToAdminChannel(`⚠️ Role removal failed for ${username} (${userId}) on ${network}: ${error}. The job tries again in the next run.`);
}

// Grant a role. Returns null when the member has the role, else the error text.
async function grantSequencerRole(discordUserId, roleId) {
  try {
    const guild = await discordClient.guilds.fetch(process.env.DISCORD_GUILD_ID);
    await memberRoles.grantRole(guild, discordUserId, roleId);
    logger.info(`Role granted to ${discordUserId}`);
    return null;
  } catch (error) {
    logger.error(`Failed to grant role to ${discordUserId}:`, error.message);
    return error.message || String(error);
  }
}

// Get all colleagues for a manager
async function getColleaguesForManager(managerDiscordId) {
  const pool = getPool();
  
  try {
    const query = `
      SELECT colleague_user_id, colleague_username, status 
      FROM colleagues 
      WHERE manager_discord_id = $1 AND status <> 'removed' 
      ORDER BY colleague_username
    `;
    
    const result = await pool.query(query, [managerDiscordId]);
    return result.rows;
  } catch (error) {
    console.error(`Error fetching colleagues:`, error.message);
    return [];
  }
}

// Update colleague status in database
async function updateColleagueStatus(managerDiscordId, colleagueDiscordId, newStatus) {
  const pool = getPool();
  
  try {
    const query = `
      UPDATE colleagues 
      SET status = $1, updated_at = NOW() 
      WHERE manager_discord_id = $2 AND colleague_user_id = $3 
      RETURNING colleague_username
    `;
    
    const result = await pool.query(query, [newStatus, managerDiscordId, colleagueDiscordId]);
    
    if (result.rows.length > 0) {
      return result.rows[0].colleague_username;
    }
    return null;
  } catch (error) {
    console.error(`Error updating colleague status:`, error.message);
    return null;
  }
}

/**
 * Phase 2.4: Dual-Role Architecture - Network-Aware Colleague Management
 * Manage colleague roles based on host status with network-specific role handling
 * @param {string} managerDiscordId - Host's Discord user ID
 * @param {string} managerUsername - Host's Discord username
 * @param {string} action - 'deactivate' or 'reactivate'
 * @param {string} network - Network (lower case). 'deactivate' needs it.
 */
async function manageColleagueRoles(managerDiscordId, managerUsername, action, network) {
  logger.info(`Managing colleague roles for ${managerUsername} - Action: ${action}${network ? ` - Network: ${network}` : ''}`);
  
  try {
    // Get all colleagues for this manager
    const colleagues = await getColleaguesForManager(managerDiscordId);
    
    if (colleagues.length === 0) {
      logger.info(`No colleagues found for ${managerUsername}`);
      return;
    }
    
    const targetStatus = 'active';
    const actionText = 'automatically re-activated';
    const logMessage = action === 'deactivate'
      ? `Colleagues of \`${managerUsername}\` lost the ${network} role, where no other path keeps it`
      : `Colleagues of \`${managerUsername}\` have been automatically re-activated`;
    
    let successCount = 0;
    let failureCount = 0;
    
    // Get manager's network registrations for dual-role architecture
    const pool = getPool();
    const managerRegistrations = { rows: (await managerNetworks(pool, managerDiscordId)).map((network) => ({ network })) };
    
    // Process each colleague
    for (const colleague of colleagues) {
      try {
        if (action === 'deactivate') {
          // The colleague record does not change: the colleague can keep the
          // role of a different network of the same manager. Remove the role
          // of this network only when no other path keeps it.
          const networkRoleId = getDiscordRoleId(network);
          if (networkRoleId && !(await keepsRole(pool, colleague.colleague_user_id, network))) {
            // No retry state for a colleague: the admins are told.
            const error = await tryRemoveSequencerRole(colleague.colleague_user_id, networkRoleId);
            if (error) {
              await logToAdminChannel(`⚠️ Role removal failed for colleague ${colleague.colleague_user_id} of ${managerUsername} on ${network}: ${error}.`);
              failureCount++;
              continue;
            }
            logger.info(`✅ Removed ${network} role from ${colleague.colleague_username}`);
          }
          successCount++;
          continue;
        }

        // Update database status
        const updatedUsername = await updateColleagueStatus(
          managerDiscordId, 
          colleague.colleague_user_id, 
          targetStatus
        );
        
        if (updatedUsername) {
          // Grant network-specific roles based on manager's registrations.
          // No retry state for a colleague: the admins are told.
          let grantFailed = false;
          for (const reg of managerRegistrations.rows) {
            const networkRoleId = getDiscordRoleId(reg.network.toLowerCase());
            if (!networkRoleId) continue;
            const error = await grantSequencerRole(colleague.colleague_user_id, networkRoleId);
            if (error) {
              await logToAdminChannel(`⚠️ Role grant failed for colleague ${colleague.colleague_user_id} of ${managerUsername} on ${reg.network.toLowerCase()}: ${error}.`);
              grantFailed = true;
              continue;
            }
            logger.info(`✅ Granted ${reg.network} role to ${updatedUsername}`);
          }

          if (grantFailed) {
            failureCount++;
          } else {
            successCount++;
            console.log(`${actionText} ${updatedUsername}`);
          }
        } else {
          failureCount++;
          console.error(`Failed to update colleague status`);
        }
      } catch (error) {
        failureCount++;
        console.error(`Error processing colleague:`, error.message);
      }
    }
    
    // Log summary
    console.log(`Colleague management completed for ${managerUsername}:`);
    console.log(`   Successful: ${successCount}, Failed: ${failureCount}`);
    console.log(`${logMessage}`);
    
    // TODO: Add admin notification/logging here in future enhancement
    
  } catch (error) {
    console.error(`Error in manageColleagueRoles:`, error.message);
  }
}

/**
 * Load network configuration based on the registration network
 * @param {string} network - Network name ('Mainnet' or 'Testnet')
 * @returns {Object} Configuration object for the specified network
 */
function loadNetworkConfig(network) {
  // Import centralized configuration
  const { getNetworkConfig } = require('./config.js');
  
  try {
    const networkConfig = getNetworkConfig(network);
    
    let config;
    
    if (network === 'Mainnet') {
      config = {
        rpcUrl: process.env.AZTEC_MAINNET_RPC_URL,
        contractAddress: process.env.AZTEC_MAINNET_ROLLUP_CONTRACT,
        registryAddress: process.env.AZTEC_MAINNET_REGISTRY_CONTRACT,
        abi: require('./mainnetRollupABI.json'),
        network: 'mainnet',
        // Add network-specific constants from centralized config
        fullStake: networkConfig.FULL_STAKE,
        tokenName: networkConfig.TOKEN_NAME,
        displayName: networkConfig.NAME
      };
    } else if (network === 'Testnet') {
      config = {
        rpcUrl: process.env.AZTEC_RPC_URL,
        contractAddress: process.env.AZTEC_ROLLUP_CONTRACT,
        registryAddress: process.env.AZTEC_REGISTRY_CONTRACT,
        abi: require('./rollupABI.json'),
        network: 'testnet',
        // Add network-specific constants from centralized config
        fullStake: networkConfig.FULL_STAKE,
        tokenName: networkConfig.TOKEN_NAME,
        displayName: networkConfig.NAME
      };
    } else {
      throw new Error(`Invalid network: ${network}`);
    }
    
    // Validate required environment variables
    if (!config.rpcUrl || (!config.contractAddress && !config.registryAddress)) {
      throw new Error(`Missing required environment variables for ${network} network`);
    }
    
    return config;
  } catch (error) {
    console.error(`Network config error:`, error.message);
    throw error;
  }
}

/**
 * Update the last notification status in database
 * @param {number} registrationId - Registration ID
 * @param {string} notificationStatus - New notification status
 */
async function updateNotificationStatus(registrationId, notificationStatus) {
  const pool = getPool();
  
  try {
    await pool.query(
      'UPDATE pending_registrations SET last_notification_status = $1 WHERE id = $2',
      [notificationStatus, registrationId]
    );
    console.log(`Updated notification status to '${notificationStatus}' for registration ${registrationId}`);
  } catch (error) {
    console.error(`Failed to update notification status:`, error.message);
  }
}

// Send a provider notification. Failures are logged, as for the other messages.
async function sendProviderDM(discordUserId, embedKey, providerId, network) {
  try {
    const user = await discordClient.users.fetch(discordUserId);
    await user.send({ embeds: [getEmbed(embedKey, { walletAddress: `Provider ${providerId}`, providerId, network })] });
  } catch (error) {
    logger.error(`Failed to send provider DM to ${discordUserId}:`, error.message);
  }
}

// The alert for each provider problem.
const PROVIDER_PROBLEM_EMBEDS = {
  PROVIDER_INACTIVE: 'notifications.providerInactive',
  SIGNER_CHANGED: 'notifications.providerSignerChanged',
  REGISTRY_CHANGED: 'notifications.providerRegistryChanged'
};

// Apply the result of one provider check: recovery, countdown or removal.
// problem is null (no problem), 'PROVIDER_INACTIVE', 'SIGNER_CHANGED' or
// 'REGISTRY_CHANGED'. network is lower case; registration.network is the
// stored name ('Mainnet'), which the messages show.
async function applyProviderState(pool, registration, network, problem) {
  const { id, discord_user_id, discord_username, provider_id } = registration;

  if (!problem) {
    if (registration.status === 'at_risk') {
      await pool.query(
        "UPDATE provider_registrations SET status = 'completed', at_risk_since = NULL, last_notification_status = 'HEALTHY', updated_at = NOW() WHERE id = $1",
        [id]
      );
      await sendProviderDM(discord_user_id, 'notifications.providerRecovered', provider_id, registration.network);
    }
    return;
  }

  const notice = problem;
  let atRiskSince = registration.at_risk_since;
  if (registration.status !== 'at_risk') {
    const updated = await pool.query(
      "UPDATE provider_registrations SET status = 'at_risk', at_risk_since = NOW(), updated_at = NOW() WHERE id = $1 RETURNING at_risk_since",
      [id]
    );
    atRiskSince = updated.rows[0].at_risk_since;
  }
  if (registration.last_notification_status !== notice) {
    await sendProviderDM(discord_user_id, PROVIDER_PROBLEM_EMBEDS[problem], provider_id, registration.network);
    await pool.query('UPDATE provider_registrations SET last_notification_status = $1 WHERE id = $2', [notice, id]);
  }

  const daysAtRisk = Math.floor((Date.now() - new Date(atRiskSince).getTime()) / (1000 * 60 * 60 * 24));
  if (daysAtRisk < 7) return;

  // Set the status first, so keepsRole sees this registration as removed.
  await pool.query("UPDATE provider_registrations SET status = 'removed', updated_at = NOW() WHERE id = $1", [id]);
  const roleId = getDiscordRoleId(network);
  if (roleId && !(await keepsRole(pool, discord_user_id, network))) {
    const error = await tryRemoveSequencerRole(discord_user_id, roleId);
    if (error) {
      await reportFailedRemoval(pool, 'provider_registrations', id, discord_username, discord_user_id, registration.network, error);
      return;
    }
  }
  await sendProviderDM(discord_user_id, 'notifications.removal', provider_id, registration.network);
  // Colleagues keep the role while the manager keeps it through a different registration.
  if (!(await keepsRole(pool, discord_user_id, network))) {
    await manageColleagueRoles(discord_user_id, discord_username, 'deactivate', network);
  }
}

// Check each provider registration in use: signer still eligible, and at least
// one active attester. A failed sync or chain read changes nothing.
// A registration for a StakingRegistry that is no longer configured is not
// read from the chain; it goes the seven-day path with a registry alert.
async function runProviderGuardianCheck() {
  const pool = getPool();
  for (const network of ['mainnet', 'testnet']) {
    const chain = providerChain.forNetwork(network);
    if (!chain) continue;
    const storedName = network.charAt(0).toUpperCase() + network.slice(1);
    const { rows: inUse } = await pool.query(
      "SELECT * FROM provider_registrations WHERE network = $1 AND status IN ('completed', 'at_risk') ORDER BY id",
      [storedName]
    );
    const registry = chain.registryAddress.toLowerCase();
    for (const registration of inUse.filter((r) => r.registry !== registry)) {
      try {
        await applyProviderState(pool, registration, network, 'REGISTRY_CHANGED');
      } catch (error) {
        console.error(`Error processing provider registration ${registration.id}:`, error.message);
      }
    }
    const rows = inUse.filter((r) => r.registry === registry);
    if (rows.length === 0) continue;

    try {
      await syncProviderAttesters(pool, network, chain);
    } catch (error) {
      console.error(`Provider attester sync failed for ${network}:`, error.message);
      continue;
    }

    for (const registration of rows) {
      try {
        const eligible = (await eligibleSignerKind(chain, registration.provider_id, registration.signer_address)) !== null;
        const active = eligible && (await isProviderActive(pool, network, registration.provider_id, chain));
        const problem = !eligible ? 'SIGNER_CHANGED' : (active ? null : 'PROVIDER_INACTIVE');
        await applyProviderState(pool, registration, network, problem);
      } catch (error) {
        console.error(`Error processing provider registration ${registration.id}:`, error.message);
      }
    }
  }
}

/**
 * Main guardian check function
 * This performs automated status checks and manages roles
 */
async function runGuardianCheck() {
  console.log('Guardian check is starting...');
  
  const pool = getPool();
  
  try {
    // Query the registrations that passed the signature check. A pending or
    // expired registration has no verified attester and must not be processed.
    console.log('Fetching registered sequencers from the database...');
    const query = `
      SELECT id, discord_user_id, discord_username, network, wallet_address, status, created_at, last_notification_status
      FROM pending_registrations 
      WHERE status IN ('completed', 'at_risk') 
      ORDER BY created_at DESC
    `;
    
    const result = await pool.query(query);
    const registrations = result.rows;
    
    console.log(`Found ${registrations.length} users to check.`);
    
    for (const registration of registrations) {
      const { id, discord_user_id, discord_username, network, wallet_address, created_at, last_notification_status } = registration;
      let status = registration.status;
      
      console.log(`Checking user: ${discord_username}, Wallet: ${wallet_address}, Network: ${network}`);
      console.log(`User's current database status is: ${status}`);
      
      try {
        // Load network configuration
        console.log(`Loading network configuration for ${network}...`);
        const networkConfig = loadNetworkConfig(network);
        
        // Fetch current on-chain status
        console.log(`Performing on-chain status check for wallet ${wallet_address}...`);
        const statusResult = await fetchOnChainStatus(wallet_address, networkConfig);
        
        if (!statusResult.success) {
          console.error(`❌ Failed to fetch status for ${wallet_address}:`, statusResult.data.error);
          continue;
        }
        
        // Use intelligent state determination
        const validatorState = determineValidatorState(statusResult.data, networkConfig.network);
        console.log(`On-chain status determined as: ${validatorState.state}`);
        
        // State-specific automated actions
        console.log('Comparing statuses... Taking action...');
        switch (validatorState.state) {
          case 'INACTIVE':
            // INACTIVE users (status = "0"): Start 7-day countdown + critical DM + colleague deactivation
            console.log(`🔄 Transition attempt: DB status='${status}' -> On-chain='INACTIVE'`);
            if (status !== 'at_risk') {
              // Update database to at_risk
              await pool.query(
                'UPDATE pending_registrations SET status = $1, at_risk_since = NOW() WHERE id = $2',
                ['at_risk', id]
              );
              
              // Refresh local status variable after database update
              const updatedResult = await pool.query(
                'SELECT status FROM pending_registrations WHERE id = $1',
                [id]
              );
              const refreshedStatus = updatedResult.rows[0].status;
              console.log(`Status refreshed: '${status}' -> '${refreshedStatus}'`);
              
              // Update the local status variable to prevent stale references
              status = refreshedStatus;
              console.log(`🔄 Local status variable updated for subsequent checks`);
              
              // Colleagues keep the role during the at-risk period, the same as the operator.
              
              console.log(`User ${discord_username} marked as at-risk (INACTIVE)`);
            }
            
            // Spam prevention: Only send DM if we haven't already sent one for INACTIVE status
            if (last_notification_status !== 'INACTIVE') {
              // Send critical DM about node being inactive
              await sendCriticalDM(discord_user_id, wallet_address, network);
              console.log(`Critical DM sent to INACTIVE user ${discord_username}`);
              
              // Update notification status to prevent spam
              await updateNotificationStatus(id, 'INACTIVE');
            } else {
              console.log(`⏭️ Skipping DM for ${discord_username} - already notified about INACTIVE status`);
            }
            break;
            
          case 'SLASHED':
            // SLASHED users: Warning DM only
            console.log(`User ${discord_username} is SLASHED - checking if DM needed`);
            
            // Spam prevention: Only send DM if we haven't already sent one for SLASHED status
            if (last_notification_status !== 'SLASHED') {
              console.log(`Sending warning DM to SLASHED user ${discord_username}`);
              
              // Send warning DM about reduced stake
              await sendWarningDM(
                discord_user_id, 
                wallet_address, 
                validatorState.details.balance.toString(),
                validatorState.details.fullStake.toString(),
                network
              );
              
              // Update notification status to prevent spam
              await updateNotificationStatus(id, 'SLASHED');
            } else {
              console.log(`⏭️ Skipping DM for ${discord_username} - already notified about SLASHED status`);
            }
            
            // Do NOT start removal countdown for SLASHED users
            // Do NOT deactivate colleagues for SLASHED users

            // The attester is active again. Stop a countdown that an earlier
            // inactive reading started.
            if (status === 'at_risk') {
              await pool.query(
                'UPDATE pending_registrations SET status = $1, at_risk_since = NULL WHERE id = $2',
                ['completed', id]
              );
              status = 'completed';
              await manageColleagueRoles(discord_user_id, discord_username, 'reactivate', network.toLowerCase());
            }
            break;
            
          case 'HEALTHY':
            // HEALTHY users (status = "1" AND balance >= full stake): Cancel countdown + safe DM + colleague re-activation
            if (status === 'at_risk') {
              // Update database back to completed
              await pool.query(
                'UPDATE pending_registrations SET status = $1, at_risk_since = NULL WHERE id = $2',
                ['completed', id]
              );
              status = 'completed';
              
              // Spam prevention: Only send DM if we haven't already sent one for HEALTHY status
              if (last_notification_status !== 'HEALTHY') {
                // Send safe DM about node being healthy
                await sendSafeDM(discord_user_id, wallet_address, network);
                
                // Update notification status to prevent spam
                await updateNotificationStatus(id, 'HEALTHY');
                
                console.log(`User ${discord_username} status restored to HEALTHY - DM sent`);
              } else {
                console.log(`⏭️ Skipping DM for ${discord_username} - already notified about HEALTHY status`);
              }
              
              // Phase 2.4: Dual-Role Architecture - Network-Aware Colleague Reactivation
              const networkRoleId = getDiscordRoleId(network.toLowerCase());
              await manageColleagueRoles(discord_user_id, discord_username, 'reactivate', network.toLowerCase());
            }
            break;
            
          default:
            console.warn(`Unknown validator state for ${discord_username}: ${validatorState.state}`);
            break;
        }
        
        // Check if 7 days have passed since at_risk status
        if (status === 'at_risk') {
          // Count from the first inactive reading, not from the registration date.
          const atRisk = await pool.query(
            'UPDATE pending_registrations SET at_risk_since = COALESCE(at_risk_since, NOW()) WHERE id = $1 RETURNING at_risk_since',
            [id]
          );
          const daysSinceAtRisk = Math.floor((new Date() - atRisk.rows[0].at_risk_since) / (1000 * 60 * 60 * 24));
          console.log(`Days since user became at-risk: ${daysSinceAtRisk} (7 days required for removal)`);
          
          if (daysSinceAtRisk >= 7) {
            const networkRoleId = getDiscordRoleId(network.toLowerCase());
            
            // Set the status first, so the check below sees this registration as removed.
            await pool.query(
              'UPDATE pending_registrations SET status = $1 WHERE id = $2',
              ['removed', id]
            );

            let removalError = null;
            if (networkRoleId && (await keepsRole(pool, discord_user_id, network.toLowerCase()))) {
              // The user keeps the role through a different registration.
            } else if (networkRoleId) {
              removalError = await tryRemoveSequencerRole(discord_user_id, networkRoleId);
            } else {
              console.error(`No role configured for ${network} network`);
            }

            if (removalError) {
              await reportFailedRemoval(pool, 'pending_registrations', id, discord_username, discord_user_id, network, removalError);
              continue;
            }

            // Send the removal notification only after a confirmed removal.
            await sendRemovalEmbed(discord_user_id, wallet_address, network);
            console.log(`Removed ${network} sequencer role from ${discord_username}`);
            
            // Colleagues lose the role together with the operator, unless the
            // operator keeps the role through a different registration.
            if (!(await keepsRole(pool, discord_user_id, network.toLowerCase()))) {
              await manageColleagueRoles(discord_user_id, discord_username, 'deactivate', network.toLowerCase());
            }
            
            console.log(`User ${discord_username} role removed after 7 days at-risk`);
          }
        }
        
      } catch (error) {
        console.error(`Error processing registration ${id}:`, error.message);
      }
    }
    
    await runProviderGuardianCheck();

    console.log('Guardian Check completed');
    
  } catch (error) {
    console.error('Error in Guardian Check:', error.message);
  }
}

/**
 * Initialize Discord client and start the guardian check
 */
async function initializeAndRun() {
  try {
    // Login to Discord
    await discordClient.login(process.env.DISCORD_BOT_TOKEN);
    
    // Wait for client to be ready
    await new Promise(resolve => {
      if (discordClient.isReady()) {
        resolve();
      } else {
        discordClient.once(Events.ClientReady, resolve);
      }
    });
    
    console.log('🤖 Discord client ready');
    
    // Run the guardian check
    await runGuardianCheck();
    
    // Close Discord client
    await discordClient.destroy();
    
  } catch (error) {
    console.error('Error initializing guardian check:', error.message);
    process.exit(1);
  }
}

/**
 * Start the cron job for automated guardian checks
 */
async function startCronJob() {
  try {
    // Login to Discord
    await discordClient.login(process.env.DISCORD_BOT_TOKEN);
    
    // Wait for client to be ready
    await new Promise(resolve => {
      if (discordClient.isReady()) {
        resolve();
      } else {
        discordClient.once(Events.ClientReady, resolve);
      }
    });
    
    console.log('🤖 Discord client ready');
    
    // Schedule the guardian check to run every 6 hours
    console.log('Starting cron job: Guardian check will run every 6 hours');
    cron.schedule('0 */6 * * *', async () => {
      console.log('\nCron job triggered: Running guardian check...');
      await runGuardianCheck();
    });
    
    console.log('Cron jobs scheduled successfully');
    
  } catch (error) {
    console.error('Error starting cron job:', error.message);
    process.exit(1);
  }
}

// Run if called directly. With --once, run one check now and exit.
if (require.main === module) {
  if (process.argv.includes('--once')) {
    initializeAndRun().then(() => process.exit(0));
  } else {
    startCronJob();
  }
}

// Export for testing
module.exports = {
  runGuardianCheck,
  runProviderGuardianCheck,
  startCronJob,
  sendCriticalDM,
  sendWarningDM,
  sendSafeDM,
  sendWarningEmbed,
  sendAllClearEmbed,
  sendRemovalEmbed,
  removeSequencerRole,
  logToAdminChannel,
  grantSequencerRole,
  getColleaguesForManager,
  updateColleagueStatus,
  manageColleagueRoles,
  updateNotificationStatus
};