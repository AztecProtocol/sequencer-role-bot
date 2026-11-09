// Faucet settings. With FAUCET_ENABLED other than 'true' the faucet is off and
// nothing else is read. With the faucet on, every value must be valid, or
// loadFaucetConfig throws; bot.js then runs with the faucet off
// (loadFaucetConfigSafely). Token amounts are whole STK. Error texts name
// variables only, never values: they go to the admin channel.
const { ethers } = require('ethers');

const MAX_WAIT_HOURS = 87600; // 10 years: far above any real wait, below a Date overflow

const DEFAULTS = {
  FAUCET_TOKEN_ADDRESS: '0x5595cb9ED193cAc2C0Bc5393313bc6115817954B',
  FAUCET_MIN_ACCOUNT_DAYS: '90',
  FAUCET_MIN_SERVER_DAYS: '7',
  FAUCET_AMOUNT: '200000',
  FAUCET_MEMBER_WAIT_HOURS: '2160',
  FAUCET_OPERATOR_WAIT_HOURS: '168',
  FAUCET_OPERATOR_MAX_30D: '400000',
  FAUCET_WALLET_MAX_30D: '400000',
  FAUCET_GLOBAL_MAX_24H: '5000000',
  FAUCET_ALERT_MIN_TOKEN: '2000000',
  FAUCET_ALERT_MIN_ETH: '0.05',
  FAUCET_MAX_FEE_GWEI: '100'
};

function loadFaucetConfig(env = process.env) {
  if (env.FAUCET_ENABLED !== 'true') return { enabled: false };

  const problems = [];
  const unparsed = new Set(); // names whose value did not parse
  // An empty value counts as unset (isolateEnv and docker env files give '').
  const read = (name) => {
    const value = env[name] === undefined ? '' : String(env[name]).trim();
    return value === '' ? (DEFAULTS[name] || '') : value;
  };
  const discordId = (name) => {
    const value = read(name);
    if (!/^\d+$/.test(value)) problems.push(`${name} must be a Discord id`);
    return value;
  };
  const whole = (name, { allowZero = false } = {}) => {
    const value = read(name);
    if (!/^\d+$/.test(value) || (!allowZero && BigInt(value) === 0n)) {
      unparsed.add(name);
      problems.push(`${name} must be a whole number${allowZero ? '' : ' above 0'}`);
      return 0n;
    }
    return BigInt(value);
  };

  const channelId = discordId('FAUCET_CHANNEL_ID');
  const verifiedRoleId = discordId('FAUCET_VERIFIED_ROLE_ID');

  const privateKey = read('FAUCET_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    problems.push('FAUCET_PRIVATE_KEY must be 0x followed by 64 hex characters');
  } else {
    // 0 and values from the curve order up are not keys. The error text is not used: it must not carry the key.
    try { ethers.computeAddress(privateKey); } catch { problems.push('FAUCET_PRIVATE_KEY is not a valid private key'); }
  }

  const tokenAddress = read('FAUCET_TOKEN_ADDRESS');
  if (!ethers.isAddress(tokenAddress)) problems.push('FAUCET_TOKEN_ADDRESS must be an Ethereum address');

  const rpcUrl = read('AZTEC_RPC_URL');
  if (!rpcUrl) problems.push('AZTEC_RPC_URL must be set to a Sepolia RPC');

  const amount = whole('FAUCET_AMOUNT');
  const waitHours = (name) => {
    const value = whole(name, { allowZero: true });
    if (value > BigInt(MAX_WAIT_HOURS)) problems.push(`${name} must be at most ${MAX_WAIT_HOURS}`);
    return Number(value);
  };
  const member = {
    amount,
    waitHours: waitHours('FAUCET_MEMBER_WAIT_HOURS'),
    max30d: amount // one claim; the member wait covers the 30-day window
  };
  const operator = {
    amount,
    waitHours: waitHours('FAUCET_OPERATOR_WAIT_HOURS'),
    max30d: whole('FAUCET_OPERATOR_MAX_30D')
  };

  const walletMax30d = whole('FAUCET_WALLET_MAX_30D');
  const globalMax24h = whole('FAUCET_GLOBAL_MAX_24H');
  // A maximum below one claim refuses every claim.
  const parsed = (...names) => names.every((name) => !unparsed.has(name));
  for (const [name, value] of [
    ['FAUCET_OPERATOR_MAX_30D', operator.max30d],
    ['FAUCET_WALLET_MAX_30D', walletMax30d],
    ['FAUCET_GLOBAL_MAX_24H', globalMax24h]
  ]) {
    if (parsed(name, 'FAUCET_AMOUNT') && value < amount) problems.push(`${name} must not be below FAUCET_AMOUNT`);
  }

  let alertMinEthWei = 0n;
  try {
    alertMinEthWei = ethers.parseEther(read('FAUCET_ALERT_MIN_ETH'));
    if (alertMinEthWei < 0n) throw new Error('negative');
  } catch {
    problems.push('FAUCET_ALERT_MIN_ETH must be an ETH amount, for example 0.05');
  }

  const config = {
    enabled: true,
    channelId,
    verifiedRoleId,
    testnetRoleId: String(env.TESTNET_SEQUENCER_ROLE_ID || ''),
    privateKey,
    tokenAddress,
    rpcUrl,
    minAccountDays: Number(whole('FAUCET_MIN_ACCOUNT_DAYS', { allowZero: true })),
    minServerDays: Number(whole('FAUCET_MIN_SERVER_DAYS', { allowZero: true })),
    member,
    operator,
    walletMax30d,
    globalMax24h,
    alertMinToken: whole('FAUCET_ALERT_MIN_TOKEN', { allowZero: true }),
    alertMinEthWei,
    maxFeeWei: whole('FAUCET_MAX_FEE_GWEI') * 10n ** 9n,
    // Settings that work but are probably not meant. bot.js logs them at start.
    warnings: []
  };
  if (!config.testnetRoleId) {
    config.warnings.push('TESTNET_SEQUENCER_ROLE_ID is empty: nobody gets the operator rule');
  }
  if (member.waitHours < 720) {
    config.warnings.push('FAUCET_MEMBER_WAIT_HOURS is below 720: a member still gets at most one claim in 30 days');
  }

  if (problems.length > 0) {
    const error = new Error(`Faucet configuration is invalid: ${problems.join('; ')}`);
    error.problems = problems;
    throw error;
  }
  return config;
}

// For bot.js: a wrong value turns the faucet off instead of stopping the bot.
// notice is the admin-channel line for that case, else null.
function loadFaucetConfigSafely(env = process.env) {
  try {
    return { config: loadFaucetConfig(env), notice: null };
  } catch (error) {
    const reason = error.problems ? error.problems.join('; ') : error.message;
    return { config: { enabled: false }, notice: `⚠️ The faucet is off: its configuration is invalid. ${reason}` };
  }
}

module.exports = { loadFaucetConfig, loadFaucetConfigSafely };
