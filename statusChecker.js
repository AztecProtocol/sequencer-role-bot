#!/usr/bin/env node

const { ethers } = require('ethers');
const dotenv = require('dotenv');
const { Command } = require('commander');
const logger = require('./utils/logger.js');
const { resolveRollupAddress, REGISTRY_ABI } = require('./rollupResolver.js');

// Load environment variables
dotenv.config();

// Load ABI files
let rollupABI = [];
let slashFactoryABI = [];

try {
  rollupABI = require('./rollupABI.json');
  slashFactoryABI = require('./slashFactoryABI.json');
} catch (error) {
  logger.warn('Warning: Could not load ABI files:', error.message);
}

// RPC Provider Cache and Configuration
const RPC_PROVIDER_CACHE = new Map();
const RPC_CONFIG = {
  maxRetries: 3,
  retryDelay: 1000, // Base delay in ms
  connectionTimeout: 10000, // 10 seconds
  requestTimeout: 30000, // 30 seconds
  healthCheckInterval: 300000 // 5 minutes
};

/**
 * Create and cache RPC providers with connection pooling
 * @param {string} rpcUrl - The RPC endpoint URL
 * @param {string} networkName - Network name for cache key
 * @returns {ethers.JsonRpcProvider} Configured provider
 */
function getOrCreateProvider(rpcUrl, networkName) {
  const cacheKey = `${networkName}:${rpcUrl}`;
  
  if (RPC_PROVIDER_CACHE.has(cacheKey)) {
    const cached = RPC_PROVIDER_CACHE.get(cacheKey);
    // Check if provider is still healthy
    if (cached.lastUsed && Date.now() - cached.lastUsed < RPC_CONFIG.healthCheckInterval) {
      return cached.provider;
    }
  }
  
  logger.info(`🔄 Creating new RPC provider for ${networkName}`);
  
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
    timeout: RPC_CONFIG.requestTimeout
  });
  
  RPC_PROVIDER_CACHE.set(cacheKey, {
    provider,
    created: Date.now(),
    lastUsed: Date.now(),
    networkName
  });
  
  return provider;
}

/**
 * Test RPC provider connection with detailed logging
 * @param {ethers.JsonRpcProvider} provider - Provider to test
 * @param {string} networkName - Network name for logging
 * @returns {Promise<boolean>} Connection success
 */
async function testProviderConnection(provider, networkName) {
  try {
    const startTime = Date.now();
    
    // Test basic connection with network info
    const networkInfo = await Promise.race([
      provider.getNetwork(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Connection timeout')), RPC_CONFIG.connectionTimeout)
      )
    ]);
    
    const responseTime = Date.now() - startTime;
    logger.info(`RPC connection successful for ${networkName} (${responseTime}ms)`);
    
    return true;
  } catch (error) {
    logger.error(`RPC connection failed for ${networkName}:`, error.message);
    return false;
  }
}

/**
 * Execute RPC call with retry logic and connection testing
 * @param {Function} rpcCall - The RPC function to execute
 * @param {string} networkName - Network name for logging
 * @param {string} operation - Operation name for logging
 * @returns {Promise<any>} RPC call result
 */
async function executeRpcWithRetry(rpcCall, networkName, operation) {
  let lastError;
  
  for (let attempt = 1; attempt <= RPC_CONFIG.maxRetries; attempt++) {
    try {
      console.log(`RPC ${operation} attempt ${attempt}/${RPC_CONFIG.maxRetries} for ${networkName}`);
      
      const result = await rpcCall();
      console.log(`RPC ${operation} successful on attempt ${attempt}`);
      
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`RPC ${operation} failed (attempt ${attempt}):`, error.message);
      
      if (attempt < RPC_CONFIG.maxRetries) {
        const delay = RPC_CONFIG.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Load configuration based on network selection
 * @param {string} network - Network name ('testnet' or 'mainnet')
 * @returns {Object} Configuration object for the specified network
 */
function loadNetworkConfig(network) {
  // Import centralized configuration
  const { getNetworkConfig, getTokenName } = require('./config.js');
  
  try {
    const networkConfig = getNetworkConfig(network);
    
    let config;
    
    if (network === 'mainnet') {
      config = {
        rpcUrl: process.env.AZTEC_MAINNET_RPC_URL,
        // Optional. When it is not set, the rollup comes from the registry.
        contractAddress: process.env.AZTEC_MAINNET_ROLLUP_CONTRACT,
        registryAddress: process.env.AZTEC_MAINNET_REGISTRY_CONTRACT,
        abi: require('./mainnetRollupABI.json'),
        network: 'mainnet',
        // Add network-specific constants from centralized config
        fullStake: networkConfig.FULL_STAKE,
        tokenName: networkConfig.TOKEN_NAME,
        displayName: networkConfig.NAME
      };
    } else if (network === 'testnet') {
      config = {
        rpcUrl: process.env.AZTEC_RPC_URL,
        // Optional. When it is not set, the rollup comes from the registry.
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
      throw new Error(`Invalid network: ${network}. Use 'testnet' or 'mainnet'.`);
    }
    
    // Validate required variables for the selected network
    if (!config.rpcUrl || (!config.contractAddress && !config.registryAddress)) {
      throw new Error(`Missing required environment variables for ${network} network`);
    }
    
    return config;
  } catch (error) {
    // An error, not an exit: bot.js calls this for each interaction, and one
    // unconfigured network must not stop the bot. The CLI main() exits.
    throw new Error(`Network config error: ${error.message}`);
  }
}

// True when the network has an RPC URL and a registry or rollup address.
function isNetworkConfigured(network) {
  try {
    loadNetworkConfig(String(network).toLowerCase());
    return true;
  } catch {
    return false;
  }
}

// Configuration constants (legacy - for backward compatibility)
const CONFIG = {
  AZTEC_RPC_URL: process.env.AZTEC_RPC_URL,
  AZTEC_ROLLUP_CONTRACT: process.env.AZTEC_ROLLUP_CONTRACT,
  AZTEC_SLASH_FACTORY_CONTRACT: process.env.AZTEC_SLASH_FACTORY_CONTRACT,
};

/**
 * Fetch sequencer status from on-chain Rollup contract with robust RPC handling
 * @param {string} attesterAddress - The attester address to check
 * @param {Object} networkConfig - Network configuration object
 * @returns {Promise<Object>} On-chain response data
 */
async function fetchOnChainStatus(attesterAddress, networkConfig = null) {
  try {
    // Use network config if provided, otherwise fall back to legacy CONFIG
    const config = networkConfig || {
      rpcUrl: CONFIG.AZTEC_RPC_URL,
      contractAddress: CONFIG.AZTEC_ROLLUP_CONTRACT,
      abi: rollupABI,
      network: 'testnet'
    };
    
    const networkName = config.network || 'unknown';
    
    // Get or create cached RPC provider
    const provider = getOrCreateProvider(config.rpcUrl, networkName);
    
    // Test connection before proceeding
    const connectionOk = await testProviderConnection(provider, networkName);
    if (!connectionOk) {
      throw new Error(`RPC connection failed for ${networkName}`);
    }
    
    // Resolve the current rollup. It changes at each network upgrade.
    const rollupAddress = await resolveRollupAddress(networkName, {
      override: config.contractAddress,
      readCanonical: config.registryAddress
        ? () => new ethers.Contract(config.registryAddress, REGISTRY_ABI, provider).getCanonicalRollup()
        : undefined
    });

    // Initialize Rollup contract with cached provider
    const rollupContract = new ethers.Contract(
      rollupAddress,
      config.abi,
      provider
    );

    // Execute RPC calls with retry logic
    const result = await executeRpcWithRetry(async () => {
      const [status, attesterView] = await Promise.all([
        rollupContract.getStatus(attesterAddress),
        rollupContract.getAttesterView(attesterAddress)
      ]);
      
      return { status, attesterView };
    }, networkName, 'statusCheck');

    return {
      status: 'success',
      data: {
        status: result.status,
        attesterView: result.attesterView
      },
      success: true,
      network: networkName,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`RPC Error for ${attesterAddress}:`, error.message);
    
    return {
      status: 'error',
      data: { 
        error: error.message,
        type: 'rpc_failure',
        timestamp: new Date().toISOString()
      },
      success: false,
      network: networkConfig?.network || 'unknown'
    };
  }
}

/**
 * Determine validator state based on on-chain data
 * @param {Object} statusData - On-chain status data from getAttesterView()
 * @param {string|Object} network - Network name ('testnet' or 'mainnet') or network config object
 * @returns {Object} { state: 'HEALTHY'|'SLASHED'|'INACTIVE', details: {...} }
 */
function determineValidatorState(statusData, network) {
  // Import getFullStake function from config
  const { getFullStake } = require('./config.js');
  
  try {
    // Extract network name from string or object
    let networkName;
    if (typeof network === 'string') {
      networkName = network.toLowerCase();
    } else if (network && typeof network === 'object' && network.network) {
      networkName = network.network.toLowerCase();
    } else {
      throw new Error('Invalid network parameter provided');
    }
    
    // INACTIVE: any status other than 1 (VALIDATING), OR status 1 but no stake.
    // 0 = NONE, 2 = ZOMBIE, 3 = EXITING: the attester does not validate,
    // even with a balance.
    if (BigInt(statusData.status) !== 1n) {
      return { 
        state: 'INACTIVE', 
        details: { reason: `Node is not validating (status = ${statusData.status})` } 
      };
    }
    
    // For active nodes (status is "1"), check stake balance
    const fullStake = getFullStake(networkName);
    const currentBalance = BigInt(statusData.attesterView?.[1] || 0);
    
    // Additional check: if balance is 0, consider as INACTIVE even if status is 1
    if (currentBalance === 0n) {
      return { 
        state: 'INACTIVE', 
        details: { reason: 'Node has no stake (balance = 0)' } 
      };
    }
    
    if (currentBalance >= fullStake) {
      return { 
        state: 'HEALTHY', 
        details: { 
          balance: currentBalance,
          fullStake: fullStake
        } 
      };
    } else {
      return { 
        state: 'SLASHED', 
        details: { 
          balance: currentBalance, 
          fullStake: fullStake,
          stakeReduction: fullStake - currentBalance
        } 
      };
    }
  } catch (error) {
    logger.error('Error determining validator state:', error.message);
    return {
      state: 'ERROR',
      details: { error: error.message }
    };
  }
}

/**
 * Format and print the status report
 * @param {string} address - The attester address
 * @param {string} type - Type of address (attester)
 * @param {Object} onChainResult - On-chain response result
 * @param {string} network - Network name ('testnet' or 'mainnet')
 */
function printReport(address, type, onChainResult, network) {
  console.log('\n' + '='.repeat(80));
  console.log(`SEQUENCER STATUS REPORT - ${type.toUpperCase()}: ${address}`);
  console.log('='.repeat(80));

  // Custom JSON replacer to handle BigInt values
  const jsonReplacer = (key, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  };

  console.log('\n⛓️  ON-CHAIN STATUS:');
  console.log('-'.repeat(40));
  if (onChainResult.success) {
    console.log('Response:', JSON.stringify(onChainResult.data, jsonReplacer, 2));
    console.log(`Validator state: ${determineValidatorState(onChainResult.data, network).state}`);
  } else {
    console.log('Error:', onChainResult.data.error);
  }

  console.log('='.repeat(80));
}

/**
 * Check status for a single address
 * @param {string} address - Address to check
 * @param {string} type - Type of address
 * @param {Object} networkConfig - Network configuration object
 */
async function checkAddressStatus(address, type = 'attester', networkConfig = null) {
  console.log(`Checking ${type} status for: ${address}`);
  
  const onChainResult = await fetchOnChainStatus(address, networkConfig);

  printReport(address, type, onChainResult, networkConfig?.network || 'testnet');
}

/**
 * Main function with commander CLI handling
 */
async function main() {
  try {
    // Setup commander
    const program = new Command();
    
    program
      .name('aztec-status-checker')
      .description('Diagnostic script for checking Aztec sequencer status')
      .version('1.0.0');

    program
      .argument('[addresses...]', 'Attester addresses to check')
      .option('-a, --all', 'Check all placeholder addresses', false)
      .option('-n, --network <network>', 'Network to use (testnet or mainnet)', 'testnet')
      .action(async (addresses, options) => {
        let addressesToCheck = addresses;

        // If no addresses provided and --all flag is used, use placeholders
        if (addressesToCheck.length === 0 && options.all) {
          addressesToCheck = [
            '0x1234567890123456789012345678901234567890', // Placeholder 1
            '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', // Placeholder 2
            '0xfedcbafedcbafedcbafedcbafedcbafedcbafedc'  // Placeholder 3
          ];
        }

        // If still no addresses, show usage
        if (addressesToCheck.length === 0) {
          program.outputHelp();
          console.log('\n💡 Usage examples:');
          console.log('  node statusChecker.js --network testnet 0x123...456 0x789...012');
          console.log('  node statusChecker.js --network mainnet 0x123...456');
          console.log('  node statusChecker.js --network testnet --all');
          console.log('  npm start -- --network mainnet 0x123...456');
          return;
        }

        // Load network configuration
        let networkConfig;
        try {
          networkConfig = loadNetworkConfig(options.network);
        } catch (error) {
          console.error(`Config error: ${error.message}`);
          process.exit(1);
        }

        console.log('Starting Aztec Status Checker...');
        console.log(`Network: ${networkConfig.network.toUpperCase()}`);
        console.log(`Rollup: ${networkConfig.contractAddress || `canonical, from registry ${networkConfig.registryAddress}`}`);
        
        // Check each address with the network configuration
        for (const address of addressesToCheck) {
          await checkAddressStatus(address, 'attester', networkConfig);
        }

        console.log('\nStatus check completed!');
      });

    // Parse command line arguments
    program.parse();

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run main function if this file is executed directly
if (require.main === module) {
  main();
}

// Export functions for testing
module.exports = {
  loadNetworkConfig,
  isNetworkConfigured,
  fetchOnChainStatus,
  determineValidatorState,
  printReport,
  checkAddressStatus,
  CONFIG
};