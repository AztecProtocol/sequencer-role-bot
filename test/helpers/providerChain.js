// A chain adapter that answers from tables the test controls.
// It has the same interface as providers/chain.js.
const ZERO = '0x0000000000000000000000000000000000000000';
const lc = (address) => String(address).toLowerCase();

function fakeProviderChain({ startBlock = 100, latest = 100, registryAddress = '0x00000000000000000000000000000000000000AA' } = {}) {
  const providers = new Map();
  const code = new Map();
  const safes = new Map();
  const stakes = [];
  const validating = new Set();
  const state = { latest, maxRange: Infinity, failNext: 0, logQueries: 0 };

  return {
    registryAddress,
    startBlock,
    state,

    setProvider(id, admin, recipient) { providers.set(Number(id), { admin, recipient }); },
    setCode(address, hex) { code.set(lc(address), hex); },
    setSafe(address, owners) { code.set(lc(address), '0x6080604052'); safes.set(lc(address), owners); },
    stake(providerId, attester, blockNumber) {
      stakes.push({ providerId: Number(providerId), attester, blockNumber });
      state.latest = Math.max(state.latest, blockNumber);
    },
    setValidating(attester, yes = true) { if (yes) validating.add(lc(attester)); else validating.delete(lc(attester)); },

    async readConfig(id) { return providers.get(Number(id)) || { admin: ZERO, recipient: ZERO }; },
    async codeAt(address) { return code.get(lc(address)) || '0x'; },
    async safeOwners(address) { return safes.has(lc(address)) ? safes.get(lc(address)) : null; },
    async latestBlock() { return state.latest; },
    async getStakeLogs(fromBlock, toBlock) {
      state.logQueries += 1;
      if (state.failNext > 0) { state.failNext -= 1; throw new Error('rpc unavailable'); }
      if (toBlock - fromBlock + 1 > state.maxRange) throw new Error('range too large');
      return stakes.filter((s) => s.blockNumber >= fromBlock && s.blockNumber <= toBlock);
    },
    async isValidating(attester) { return validating.has(lc(attester)); }
  };
}

module.exports = { fakeProviderChain, ZERO };
