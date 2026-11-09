// Sends STK from the faucet wallet. All transfers go through one queue, so the
// wallet nonce cannot collide. The transaction hash is stored (onSigned)
// before the broadcast, so a restart can always find a sent transfer.
const { ethers } = require('ethers');

const SEPOLIA_CHAIN_ID = 11155111;
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

// Refuses a populated transaction whose gas price is above the ceiling, before
// it is signed: a fee spike must not drain the faucet ETH.
function checkMaxFee(request, maxFeeWei) {
  const price = request.maxFeePerGas !== undefined && request.maxFeePerGas !== null ? request.maxFeePerGas : request.gasPrice;
  if (price !== undefined && price !== null && BigInt(price) > maxFeeWei) {
    throw new Error(`gas price above FAUCET_MAX_FEE_GWEI (${ethers.formatUnits(BigInt(price), 'gwei')} gwei)`);
  }
}

const shortError = (error) => String((error && (error.shortMessage || error.message)) || error).slice(0, 300);

// The chain boundary. Tests replace it with a fake that has the same methods.
function ethersChain({ rpcUrl, privateKey, tokenAddress, maxFeeWei }) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, SEPOLIA_CHAIN_ID, { staticNetwork: true });
  const wallet = new ethers.Wallet(privateKey, provider);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return {
    address: wallet.address,
    async decimals() { return BigInt(await token.decimals()); },
    async tokenBalance() { return token.balanceOf(wallet.address); },
    async ethBalance() { return provider.getBalance(wallet.address); },
    async signTransfer(to, amount) {
      const request = await wallet.populateTransaction({
        to: tokenAddress,
        data: token.interface.encodeFunctionData('transfer', [to, amount])
      });
      if (maxFeeWei !== undefined && maxFeeWei !== null) checkMaxFee(request, maxFeeWei);
      const signed = await wallet.signTransaction(request);
      return { signed, hash: ethers.Transaction.from(signed).hash, nonce: Number(request.nonce) };
    },
    async broadcast(signed) { await provider.broadcastTransaction(signed); },
    async waitForReceipt(hash, timeoutMs) {
      try {
        const receipt = await provider.waitForTransaction(hash, 1, timeoutMs);
        return receipt ? { status: receipt.status } : null;
      } catch (error) {
        if (error && error.code === 'TIMEOUT') return null;
        throw error;
      }
    },
    async getReceipt(hash) {
      const receipt = await provider.getTransactionReceipt(hash);
      return receipt ? { status: receipt.status } : null;
    },
    async knowsTransaction(hash) { return (await provider.getTransaction(hash)) !== null; },
    destroy() { provider.destroy(); }
  };
}

function createSender(config, chain = ethersChain(config), { timeoutMs = CONFIRM_TIMEOUT_MS } = {}) {
  let queue = Promise.resolve();
  let unitPromise = null;

  async function sendNow(to, amount, onSigned) {
    let tx;
    try {
      tx = await chain.signTransfer(to, amount);
    } catch (error) {
      return { status: 'failed', hash: null, error: shortError(error) };
    }

    try {
      // The nonce is stored too: staff compare it with the wallet nonce before
      // they fail a row by hand (README, Operation).
      const nonce = tx.nonce === undefined || tx.nonce === null ? null : tx.nonce;
      if ((await onSigned(tx.hash, nonce)) === false) return { status: 'aborted', hash: tx.hash };
    } catch (error) {
      return { status: 'aborted', hash: tx.hash, error: shortError(error) };
    }

    try {
      await chain.broadcast(tx.signed);
    } catch (error) {
      // NONCE_EXPIRED: the node already sees a higher nonce. That can be another
      // transaction, or this one mined through another path, and a load-balanced
      // RPC can be behind on the next read. Only a receipt decides here; without
      // one the claim keeps counting and staff settle it (README, Operation).
      if (error && error.code === 'NONCE_EXPIRED') {
        try {
          const receipt = await chain.getReceipt(tx.hash);
          if (receipt && receipt.status === 1) return { status: 'confirmed', hash: tx.hash };
          if (receipt) return { status: 'failed', hash: tx.hash, error: 'transaction reverted' };
        } catch {
          // When unsure, the claim keeps counting.
        }
        return { status: 'pending', hash: tx.hash, error: shortError(error) };
      }
      // The node can accept a transaction and still answer with an error.
      // The claim stays pending; recovery reads the receipt later.
      return { status: 'pending', hash: tx.hash, error: shortError(error) };
    }

    let receipt = null;
    try {
      receipt = await chain.waitForReceipt(tx.hash, timeoutMs);
    } catch {
      receipt = null;
    }
    if (!receipt) return { status: 'pending', hash: tx.hash };
    if (receipt.status === 1) return { status: 'confirmed', hash: tx.hash };
    return { status: 'failed', hash: tx.hash, error: 'transaction reverted' };
  }

  return {
    address: chain.address,
    unit() {
      if (!unitPromise) {
        unitPromise = chain.decimals().then((decimals) => 10n ** decimals);
        unitPromise.catch(() => { unitPromise = null; });
      }
      return unitPromise;
    },
    async balances() {
      return { token: await chain.tokenBalance(), eth: await chain.ethBalance() };
    },
    send(to, amount, onSigned) {
      const run = queue.then(() => sendNow(to, amount, onSigned));
      queue = run.catch(() => {});
      return run;
    },
    // Ends the RPC connection. A fake chain may have no destroy.
    close() {
      if (typeof chain.destroy === 'function') chain.destroy();
    },
    async receipt(hash) {
      const receipt = await chain.getReceipt(hash);
      if (receipt) return receipt.status === 1 ? 'confirmed' : 'failed';
      return (await chain.knowsTransaction(hash)) ? 'pending' : 'unknown';
    }
  };
}

module.exports = { ethersChain, createSender, checkMaxFee, SEPOLIA_CHAIN_ID };
