// Network Configuration for Aztec Guardian Bot

// Network configuration constants

// FULL_STAKE is the activation threshold: 200,000 tokens on mainnet and on
// testnet, read from the chain on 2026-10-19. The testnet staking token
// symbol is STK.
/** @type {Record<string, NetworkConfig>} */
const NETWORKS = {
  testnet: {
    NAME: 'Testnet',
    FULL_STAKE: 200000000000000000000000n, // 200,000 STK
    TOKEN_NAME: 'STK'
  },

  mainnet: {
    NAME: 'Mainnet',
    FULL_STAKE: 200000000000000000000000n, // 200,000 AZTEC
    TOKEN_NAME: 'AZTEC'
  }
};

const VALID_NETWORKS = Object.keys(NETWORKS);

const DEFAULT_NETWORK = 'testnet';

// Validate if network is supported
function isValidNetwork(network) {
  return VALID_NETWORKS.includes(network.toLowerCase());
}

// Get normalized network name
function getNormalizedNetwork(network) {
  return network.toLowerCase();
}

// Get network configuration
function getNetworkConfig(network) {
  const normalizedNetwork = getNormalizedNetwork(network);
  
  if (!isValidNetwork(normalizedNetwork)) {
    throw new Error(`Unsupported network: ${network}. Supported networks: ${VALID_NETWORKS.join(', ')}`);
  }
  
  return NETWORKS[normalizedNetwork];
}

// Get full stake amount
function getFullStake(network) {
  return getNetworkConfig(network).FULL_STAKE;
}

// Get token name
function getTokenName(network) {
  return getNetworkConfig(network).TOKEN_NAME;
}

// Get display name
function getNetworkDisplayName(network) {
  return getNetworkConfig(network).NAME;
}

// Check if stake is full
function isFullStake(stakeAmount, network) {
  const fullStakeThreshold = getFullStake(network);
  return stakeAmount >= fullStakeThreshold;
}

// Discord Role Configuration

// Get Discord role ID
function getDiscordRoleId(network) {
  const normalizedNetwork = getNormalizedNetwork(network);
  
  switch (normalizedNetwork) {
    case 'testnet':
      return process.env.TESTNET_SEQUENCER_ROLE_ID || null;
    case 'mainnet':
      return process.env.MAINNET_SEQUENCER_ROLE_ID || null;
    default:
      return null;
  }
}

// Get all role IDs
function getAllDiscordRoleIds() {
  return {
    testnet: getDiscordRoleId('testnet'),
    mainnet: getDiscordRoleId('mainnet'),
    legacy: process.env.SEQUENCER_ROLE_ID || null
  };
}

// Validate role ID format
function validateDiscordRoleId(roleId) {
  if (!roleId || typeof roleId !== 'string') {
    return false;
  }
  // Discord role IDs are numeric strings
  return /^\d+$/.test(roleId);
}

// Check dual-role configuration
function getDualRoleConfigurationStatus() {
  const status = {
    configured: true,
    missing: [],
    errors: []
  };

  const testnetRole = process.env.TESTNET_SEQUENCER_ROLE_ID;
  const mainnetRole = process.env.MAINNET_SEQUENCER_ROLE_ID;

  // Check for missing role IDs
  if (!testnetRole || testnetRole === 'YOUR_TESTNET_ROLE_ID_HERE') {
    status.configured = false;
    status.missing.push('TESTNET_SEQUENCER_ROLE_ID');
  }

  if (!mainnetRole || mainnetRole === 'YOUR_MAINNET_ROLE_ID_HERE') {
    status.configured = false;
    status.missing.push('MAINNET_SEQUENCER_ROLE_ID');
  }

  // Validate role ID formats
  if (testnetRole && !validateDiscordRoleId(testnetRole)) {
    status.configured = false;
    status.errors.push('TESTNET_SEQUENCER_ROLE_ID: Invalid Discord role ID format');
  }

  if (mainnetRole && !validateDiscordRoleId(mainnetRole)) {
    status.configured = false;
    status.errors.push('MAINNET_SEQUENCER_ROLE_ID: Invalid Discord role ID format');
  }

  // Check for duplicate role assignments
  if (testnetRole && mainnetRole && testnetRole === mainnetRole) {
    status.configured = false;
    status.errors.push('TESTNET_SEQUENCER_ROLE_ID and MAINNET_SEQUENCER_ROLE_ID cannot be the same');
  }

  return status;
}

// Get user permissions
function getUserPermissions(userRoles, network) {
  const normalizedNetwork = getNormalizedNetwork(network);
  const roleIds = getAllDiscordRoleIds();
  
  const permissions = {
    hasPermission: false,
    canAccessTestnet: false,
    canAccessMainnet: false,
    isLegacy: false,
    networks: []
  };

  // Check testnet access
  if (userRoles.hasOwnProperty(roleIds.testnet) || userRoles.hasOwnProperty('testnet')) {
    permissions.canAccessTestnet = true;
    permissions.networks.push('testnet');
  }

  // Check mainnet access
  if (userRoles.hasOwnProperty(roleIds.mainnet) || userRoles.hasOwnProperty('mainnet')) {
    permissions.canAccessMainnet = true;
    permissions.networks.push('mainnet');
  }

  // Check legacy role access
  if (roleIds.legacy && userRoles.hasOwnProperty(roleIds.legacy)) {
    permissions.isLegacy = true;
    permissions.canAccessTestnet = true;
    permissions.canAccessMainnet = true;
    permissions.networks.push('testnet', 'mainnet');
  }

  // Set specific network permission
  if (normalizedNetwork === 'testnet') {
    permissions.hasPermission = permissions.canAccessTestnet;
  } else if (normalizedNetwork === 'mainnet') {
    permissions.hasPermission = permissions.canAccessMainnet;
  }

  return permissions;
}

// Legacy compatibility
const LEGACY_CONFIG = {
  NETWORKS,
  DEFAULT_NETWORK,
  VALID_NETWORKS,
  getNetworkConfig,
  getFullStake,
  getTokenName,
  getNetworkDisplayName,
  isValidNetwork,
  isFullStake,
  // Dual-role compatibility
  getDiscordRoleId,
  getAllDiscordRoleIds,
  validateDiscordRoleId,
  getDualRoleConfigurationStatus,
  getUserPermissions
};

module.exports = {
  NETWORKS,
  VALID_NETWORKS,
  DEFAULT_NETWORK,
  isValidNetwork,
  getNormalizedNetwork,
  getNetworkConfig,
  getFullStake,
  getTokenName,
  getNetworkDisplayName,
  isFullStake,
  getDiscordRoleId,
  getAllDiscordRoleIds,
  validateDiscordRoleId,
  getDualRoleConfigurationStatus,
  getUserPermissions,
  LEGACY_CONFIG
};