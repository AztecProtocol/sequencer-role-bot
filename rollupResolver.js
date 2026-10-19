// Resolves the address of the current rollup contract.
//
// The rollup address changes at each network upgrade. The Registry address
// does not, and Registry.getCanonicalRollup() returns the current rollup. An
// old rollup continues to answer view calls after an upgrade, but reports
// every attester as inactive, so a fixed rollup address fails silently.

const REGISTRY_ABI = ['function getCanonicalRollup() view returns (address)'];
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

function sameAddress(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * The returned function also has onCanonicalChange(callback): the callback
 * gets (network, oldAddress, newAddress) once for each canonical change.
 * @param {{warn?: (message: string) => void}} options
 * @returns {(network: string, source: {override?: string, readCanonical?: () => Promise<string>}) => Promise<string>}
 */
function createRollupResolver({ warn = console.warn } = {}) {
  const cache = new Map(); // network -> { address, readAt }
  const reportedOverrides = new Set();
  const subscribers = [];

  // A failing subscriber must not stop the resolver.
  function notifyChange(network, from, to) {
    for (const callback of subscribers) {
      try {
        Promise.resolve(callback(network, from, to)).catch((error) => warn(`A rollup change subscriber failed: ${error.message}`));
      } catch (error) {
        warn(`A rollup change subscriber failed: ${error.message}`);
      }
    }
  }

  async function canonical(network, readCanonical) {
    const known = cache.get(network);
    if (known && Date.now() - known.readAt < REFRESH_INTERVAL_MS) {
      return known.address;
    }

    let address;
    try {
      address = await readCanonical();
    } catch (error) {
      if (!known) throw error;
      warn(`Could not read the canonical rollup for ${network} (${error.message}). Using the last known rollup ${known.address}.`);
      return known.address;
    }

    if (known && !sameAddress(known.address, address)) {
      warn(`The canonical rollup for ${network} changed from ${known.address} to ${address}.`);
      notifyChange(network, known.address, address);
    }
    cache.set(network, { address, readAt: Date.now() });
    return address;
  }

  async function resolveRollupAddress(network, { override, readCanonical } = {}) {
    if (!override && !readCanonical) {
      throw new Error(`No registry address and no rollup address are configured for ${network}`);
    }
    if (!override) {
      return canonical(network, readCanonical);
    }

    // A configured address is for tests. Report it once if it is not canonical.
    if (readCanonical && !reportedOverrides.has(`${network}:${override}`)) {
      try {
        const current = await canonical(network, readCanonical);
        if (!sameAddress(current, override)) {
          warn(`The configured rollup ${override} for ${network} is not the canonical rollup ${current}. Attesters can show as inactive.`);
        }
        reportedOverrides.add(`${network}:${override}`);
      } catch (error) {
        // The configured address does not depend on the registry.
      }
    }
    return override;
  }
  resolveRollupAddress.onCanonicalChange = (callback) => { subscribers.push(callback); };
  return resolveRollupAddress;
}

// One resolver for the process, shared by statusChecker.js and providers/chain.js.
const sharedResolver = createRollupResolver();

module.exports = {
  createRollupResolver,
  resolveRollupAddress: sharedResolver,
  onCanonicalChange: sharedResolver.onCanonicalChange,
  REGISTRY_ABI
};
