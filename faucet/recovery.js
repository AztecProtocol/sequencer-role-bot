// Settles faucet claims that a restart or a timeout left open, and posts the
// faucet alerts. Rule: when unsure, a claim keeps counting. The faucet never
// pays twice; a member can lose quota in a rare case.
const { formatEther } = require('ethers');
const ledger = require('./ledger.js');
const logger = require('../utils/logger.js');

// The status job only settles rows that the running bot has not touched for
// this long, so a claim that waits in the bot's queue is not failed.
const RECOVERY_AGE_MS = 30 * 60 * 1000;

// Posts `text` only if no alert of this kind was posted in the last 24 hours.
async function alertOnce(pool, kind, now, post, text) {
  const { rowCount } = await pool.query(
    `INSERT INTO faucet_alerts (kind, sent_at) VALUES ($1, $2)
     ON CONFLICT (kind) DO UPDATE SET sent_at = EXCLUDED.sent_at
     WHERE faucet_alerts.sent_at <= EXCLUDED.sent_at - INTERVAL '24 hours'`,
    [kind, now]
  );
  if (rowCount === 0) return false;
  try {
    await post(text);
  } catch (error) {
    // The alert was not posted: free this attempt's slot so a later call can post it.
    await pool.query('DELETE FROM faucet_alerts WHERE kind = $1 AND sent_at = $2', [kind, now]);
    throw error;
  }
  return true;
}

// Posts an alert and logs a failure instead of throwing, so one failed post
// does not stop the caller's other work.
async function alertSafely(pool, kind, now, post, text) {
  try {
    return await alertOnce(pool, kind, now, post, text);
  } catch (error) {
    logger.error(`Faucet alert failed: ${error.message}`);
    return false;
  }
}

async function settleClaims({ pool, sender, post, now, minAgeMs }) {
  const counts = { failed: 0, confirmed: 0, pending: 0, unknown: 0 };
  const rows = await ledger.rowsToSettle(pool, new Date(now.getTime() - minAgeMs));
  for (const row of rows) {
    if (row.status === 'reserved') {
      // No hash in the snapshot: the transfer was not broadcast then. The bot may
      // have broadcast it since, so release only a row that is still reserved.
      // If it moved on, the next run sees it as sent.
      if (await ledger.releaseReservation(pool, row.id, 'never broadcast (settled by recovery)', now)) counts.failed += 1;
      continue;
    }
    let state;
    try {
      state = await sender.receipt(row.tx_hash);
    } catch {
      state = 'pending';
    }
    if (state === 'confirmed') {
      if (!(await ledger.markConfirmed(pool, row.id, now))) {
        logger.warn(`Faucet claim ${row.id} is confirmed on chain, but its row was not in status sent (settled by recovery)`);
      }
      counts.confirmed += 1;
    } else if (state === 'failed') {
      await ledger.markFailed(pool, row.id, 'transaction reverted (settled by recovery)', now);
      counts.failed += 1;
    } else if (state === 'unknown') {
      counts.unknown += 1;
      await alertSafely(pool, `unknown_tx:${row.id}`, now, post,
        `⚠️ Faucet claim ${row.id}: transaction ${row.tx_hash} (nonce ${row.nonce === null ? 'unknown' : row.nonce}) is unknown to the RPC. ` +
        'The claim still counts against the limits. Check it on Etherscan and update the row by hand.');
    } else {
      counts.pending += 1;
    }
  }
  return counts;
}

// Rejects if the balance read fails; callers catch it.
async function checkBalances({ pool, sender, config, unit, post, now }) {
  const { token, eth } = await sender.balances();
  if (token < config.alertMinToken * unit) {
    await alertSafely(pool, 'low_token', now, post,
      `⚠️ The faucet wallet ${sender.address} holds ${token / unit} STK. Send more STK before it runs out.`);
  }
  if (eth < config.alertMinEthWei) {
    await alertSafely(pool, 'low_eth', now, post,
      `⚠️ The faucet wallet ${sender.address} holds ${formatEther(eth)} ETH on Sepolia. Send ETH for gas.`);
  }
}

module.exports = { RECOVERY_AGE_MS, alertOnce, alertSafely, settleClaims, checkBalances };
