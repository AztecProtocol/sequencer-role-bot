// Chain access for provider registration, one adapter for each network.
// Returns null when no StakingRegistry is configured for the network, or when
// its start block is missing or not a block number.
const { ethers } = require('ethers');
const { resolveRollupAddress, REGISTRY_ABI } = require('../rollupResolver.js');

const STAKING_REGISTRY_ABI = [
  'function providerConfigurations(uint256) view returns (address providerAdmin, uint16 providerTakeRate, address providerRewardsRecipient)',
  'event StakedWithProvider(uint256 indexed providerIdentifier, address indexed rollupAddress, address indexed attester, address coinbaseSplitContractAddress, address stakerAddress)'
];
const SAFE_ABI = ['function getOwners() view returns (address[])'];
const ROLLUP_ABI = ['function getStatus(address) view returns (uint8)'];

const SETTINGS = {
  mainnet: {
    chainId: 1,
    rpc: 'AZTEC_MAINNET_RPC_URL',
    stakingRegistry: 'AZTEC_MAINNET_STAKING_REGISTRY_CONTRACT',
    startBlock: 'AZTEC_MAINNET_STAKING_REGISTRY_START_BLOCK',
    registry: 'AZTEC_MAINNET_REGISTRY_CONTRACT',
    rollup: 'AZTEC_MAINNET_ROLLUP_CONTRACT'
  },
  testnet: {
    chainId: 11155111, // Sepolia
    rpc: 'AZTEC_RPC_URL',
    stakingRegistry: 'AZTEC_STAKING_REGISTRY_CONTRACT',
    startBlock: 'AZTEC_STAKING_REGISTRY_START_BLOCK',
    registry: 'AZTEC_REGISTRY_CONTRACT',
    rollup: 'AZTEC_ROLLUP_CONTRACT'
  }
};

const adapters = new Map();
const startBlockErrorsLogged = new Set();

// The start block must be a non-negative safe integer. A wrong value would
// skip stake events, and then the job would remove roles of active providers.
function parseStartBlock(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const block = Number(value.trim());
  return Number.isSafeInteger(block) ? block : null;
}

function forNetwork(network) {
  const name = String(network).toLowerCase();
  const settings = SETTINGS[name];
  if (!settings) return null;
  const env = (key) => process.env[settings[key]];
  if (!env('rpc') || !env('stakingRegistry')) return null;
  const startBlock = parseStartBlock(env('startBlock'));
  if (startBlock === null) {
    if (!startBlockErrorsLogged.has(name)) {
      startBlockErrorsLogged.add(name);
      console.error(`Provider registration is off for ${name}: ${settings.startBlock} must be a block number`);
    }
    return null;
  }

  const cacheKey = `${name}:${env('rpc')}:${env('stakingRegistry')}:${startBlock}`;
  if (adapters.has(cacheKey)) return adapters.get(cacheKey);

  // A fixed chain id stops ethers from retrying network detection forever
  // when the RPC is down. Calls then fail at once with the transport error.
  const chainNetwork = { chainId: settings.chainId, name: name === 'mainnet' ? 'mainnet' : 'sepolia' };
  const provider = new ethers.JsonRpcProvider(env('rpc'), chainNetwork, { staticNetwork: true });
  const stakingRegistry = new ethers.Contract(env('stakingRegistry'), STAKING_REGISTRY_ABI, provider);
  const stakeTopic = stakingRegistry.interface.getEvent('StakedWithProvider').topicHash;

  async function rollup() {
    const address = await resolveRollupAddress(name, {
      override: env('rollup'),
      readCanonical: env('registry')
        ? () => new ethers.Contract(env('registry'), REGISTRY_ABI, provider).getCanonicalRollup()
        : undefined
    });
    return new ethers.Contract(address, ROLLUP_ABI, provider);
  }

  const chain = {
    registryAddress: env('stakingRegistry'),
    startBlock,
    async readConfig(providerId) {
      const config = await stakingRegistry.providerConfigurations(providerId);
      return { admin: config.providerAdmin, recipient: config.providerRewardsRecipient };
    },
    codeAt: (address) => provider.getCode(address),
    async safeOwners(address) {
      try {
        return await new ethers.Contract(address, SAFE_ABI, provider).getOwners();
      } catch (error) {
        // A revert or empty return data means the address is not a Safe.
        // Any other error (network, timeout) is a failed read. It must not
        // read as "not a Safe", or a caller would treat the owner as changed.
        if (error.code === 'CALL_EXCEPTION' || error.code === 'BAD_DATA') return null;
        throw error;
      }
    },
    latestBlock: () => provider.getBlockNumber(),
    async getStakeLogs(fromBlock, toBlock) {
      const logs = await provider.getLogs({
        address: env('stakingRegistry'), topics: [stakeTopic], fromBlock, toBlock
      });
      return logs.map((log) => {
        const args = stakingRegistry.interface.parseLog(log).args;
        return { providerId: Number(args.providerIdentifier), attester: args.attester, blockNumber: log.blockNumber };
      });
    },
    async isValidating(attester) {
      return (await (await rollup()).getStatus(attester)) === 1n;
    }
  };
  adapters.set(cacheKey, chain);
  return chain;
}

module.exports = { forNetwork };
