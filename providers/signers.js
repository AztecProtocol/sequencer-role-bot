// Which addresses can sign for a provider in the StakingRegistry.
// Eligible: the admin or the rewards recipient if it is a plain key (with or
// without EIP-7702 code), or an owner of a Safe in one of those two roles.
const ZERO = '0x0000000000000000000000000000000000000000';
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const isPlainKey = (code) => code === '0x' || String(code).toLowerCase().startsWith('0xef0100');

async function providerExists(chain, providerId) {
  const config = await chain.readConfig(providerId);
  return Boolean(config) && !same(config.admin, ZERO);
}

async function eligibleSignerKind(chain, providerId, signer) {
  const config = await chain.readConfig(providerId);
  if (!config || same(config.admin, ZERO)) return null;

  for (const [role, address] of [['admin', config.admin], ['recipient', config.recipient]]) {
    if (!address || same(address, ZERO)) continue;
    const code = await chain.codeAt(address);
    if (isPlainKey(code)) {
      if (same(address, signer)) return role;
      continue;
    }
    const owners = await chain.safeOwners(address);
    if (owners && owners.some((owner) => same(owner, signer))) return `${role}_safe_owner`;
  }
  return null;
}

module.exports = { eligibleSignerKind, providerExists };
