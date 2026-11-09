// The faucet_claims table. All limit checks and the reservation run in one
// transaction under one advisory lock, so parallel requests cannot pass a cap
// together. Amounts are bigint base units, times are Date objects.
const FAUCET_LOCK_KEY = 4815162342n; // any fixed bigint, used only by the faucet
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_30D_MS = 30 * DAY_MS;

const plus = (date, ms) => (date ? new Date(date.getTime() + ms) : null);

// fixed/step: variable-amount limits are used only in tests today; the flow
// always sends fixed limits. Kept so the ledger still supports them.
function tierLimits(config, tier, unit) {
  const settings = tier === 2 ? config.operator : config.member;
  return {
    tier,
    fixed: true,
    maxAmount: settings.amount * unit,
    step: unit,
    waitMs: settings.waitHours * HOUR_MS,
    max30d: settings.max30d * unit
  };
}

// The counted claims (not failed) in a window, oldest first, and their sum.
// column null = every claim (the global cap). A waived claim still counts,
// unless excludeWaived is set (the per-user limits).
async function windowUse(db, column, value, now, interval, { excludeWaived = false } = {}) {
  const where = `${column ? `${column} = $2 AND` : ''}${excludeWaived ? ' waived_at IS NULL AND' : ''}`;
  const params = column ? [now, value] : [now];
  const { rows } = await db.query(
    `SELECT amount::text AS amount, created_at
     FROM faucet_claims
     WHERE ${where} status <> 'failed' AND created_at > $1::timestamptz - INTERVAL '${interval}'
     ORDER BY created_at, id`,
    params
  );
  const claims = rows.map((row) => ({ amount: BigInt(row.amount), createdAt: row.created_at }));
  return { used: claims.reduce((sum, claim) => sum + claim.amount, 0n), claims };
}

// The earliest time at which enough of the window frees for `needed`: claims
// leave the window oldest first, each at created_at + window. null = never.
function freeAt(use, needed, max, windowMs) {
  let freed = 0n;
  for (const claim of use.claims) {
    freed += claim.amount;
    if (use.used - freed + needed <= max) return plus(claim.createdAt, windowMs);
  }
  return null;
}

async function userState(db, userId, now) {
  const { rows } = await db.query(
    `SELECT MAX(created_at) AS last_at FROM faucet_claims
     WHERE discord_user_id = $1 AND status <> 'failed' AND waived_at IS NULL`,
    [userId]
  );
  return { lastAt: rows[0].last_at, ...(await windowUse(db, 'discord_user_id', userId, now, '30 days', { excludeWaived: true })) };
}

function checkUser(state, limits, needed, now) {
  if (state.lastAt) {
    const nextAt = plus(state.lastAt, limits.waitMs);
    if (now < nextAt) return { ok: false, reason: 'wait', until: nextAt };
  }
  const remaining = limits.max30d - state.used;
  if (remaining < needed) return { ok: false, reason: 'user_30d', until: freeAt(state, needed, limits.max30d, WINDOW_30D_MS) };
  return { ok: true, remaining };
}

// The early answer before the form: may this member claim at all?
async function nextClaimCheck(pool, { userId, limits, now }) {
  const needed = limits.fixed ? limits.maxAmount : limits.step;
  return checkUser(await userState(pool, userId, now), limits, needed, now);
}

async function reserve(pool, { userId, wallet, limits, amount, walletMax30d, globalMax24h, now }) {
  // The flow computes the amount from the limits; a mismatch is a bug, not a refusal.
  if (amount <= 0n || amount > limits.maxAmount || (limits.fixed && amount !== limits.maxAmount)) {
    throw new Error(`Faucet reserve: amount ${amount} does not fit the tier ${limits.tier} limits`);
  }
  const address = wallet.toLowerCase();
  const client = await pool.connect();
  let rollbackFailed = false;
  const refuse = async (result) => { await client.query('ROLLBACK'); return result; };
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [FAUCET_LOCK_KEY.toString()]);

    const user = checkUser(await userState(client, userId, now), limits, amount, now);
    if (!user.ok) return await refuse(user);

    const walletUse = await windowUse(client, 'wallet_address', address, now, '30 days');
    if (walletUse.used + amount > walletMax30d) {
      return await refuse({ ok: false, reason: 'wallet_30d', until: freeAt(walletUse, amount, walletMax30d, WINDOW_30D_MS) });
    }
    const globalUse = await windowUse(client, null, null, now, '24 hours');
    if (globalUse.used + amount > globalMax24h) {
      return await refuse({ ok: false, reason: 'global_24h', until: freeAt(globalUse, amount, globalMax24h, DAY_MS) });
    }

    const { rows } = await client.query(
      `INSERT INTO faucet_claims (discord_user_id, wallet_address, tier, amount, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'reserved', $5, $5) RETURNING id`,
      [userId, address, limits.tier, amount.toString(), now]
    );
    await client.query('COMMIT');
    return { ok: true, id: rows[0].id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { rollbackFailed = true; });
    throw error;
  } finally {
    // A connection with a failed ROLLBACK may hold the advisory lock: destroy it.
    client.release(rollbackFailed);
  }
}

// Staff reset: waive the confirmed claims of a member so the per-user limits
// no longer count them. Refused while a reserved or sent claim is open.
const REASON_MAX = 200;
async function waiveClaims(pool, { userId, staffId, reason = null, now = new Date() }) {
  const note = reason === null || reason === undefined ? null : (String(reason).trim().slice(0, REASON_MAX) || null);
  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [FAUCET_LOCK_KEY.toString()]);
    const open = await client.query(
      `SELECT id, status, nonce FROM faucet_claims
       WHERE discord_user_id = $1 AND status IN ('reserved', 'sent') ORDER BY id LIMIT 1`,
      [userId]
    );
    if (open.rows.length > 0) {
      await client.query('ROLLBACK');
      const row = open.rows[0];
      return { ok: false, reason: 'open_claim', claim: { id: row.id, status: row.status, nonce: row.nonce === null ? null : Number(row.nonce) } };
    }
    const { rows } = await client.query(
      `UPDATE faucet_claims SET waived_at = $2, waived_by = $3, waived_reason = $4, updated_at = $2
       WHERE discord_user_id = $1 AND status = 'confirmed' AND waived_at IS NULL
       RETURNING id, created_at, amount::text AS amount`,
      [userId, now, staffId, note]
    );
    await client.query('COMMIT');
    return { ok: true, waived: rows.sort((a, b) => a.id - b.id).map((r) => ({ id: r.id, createdAt: r.created_at, amount: BigInt(r.amount) })) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { rollbackFailed = true; });
    throw error;
  } finally {
    // A connection with a failed ROLLBACK may hold the advisory lock: destroy it.
    client.release(rollbackFailed);
  }
}

async function setStatus(pool, id, status, fromStatuses, fields, now) {
  const sets = ['status = $2', 'updated_at = $3'];
  const params = [id, status, now, fromStatuses];
  for (const [column, value] of Object.entries(fields)) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  const { rowCount } = await pool.query(
    `UPDATE faucet_claims SET ${sets.join(', ')} WHERE id = $1 AND status = ANY($4::text[])`,
    params
  );
  return rowCount === 1;
}

// Only a reserved row may be sent. If recovery already failed the row, the
// sender must not broadcast.
const markSent = (pool, id, txHash, now = new Date(), nonce = null) =>
  setStatus(pool, id, 'sent', ['reserved'], { tx_hash: txHash, nonce }, now);
const markConfirmed = (pool, id, now = new Date()) => setStatus(pool, id, 'confirmed', ['sent'], {}, now);
// For a send that threw before any broadcast was recorded: only a reserved row
// may be released. A sent row stays, because the transfer may have happened.
const releaseReservation = (pool, id, error, now = new Date()) =>
  setStatus(pool, id, 'failed', ['reserved'], { error: String(error).slice(0, 500) }, now);
const markFailed = (pool, id, error, now = new Date()) =>
  setStatus(pool, id, 'failed', ['reserved', 'sent'], { error: String(error).slice(0, 500) }, now);

async function rowsToSettle(pool, olderThan) {
  const { rows } = await pool.query(
    `SELECT id, status, tx_hash, nonce FROM faucet_claims
     WHERE status IN ('reserved', 'sent') AND updated_at <= $1
     ORDER BY id`,
    [olderThan]
  );
  return rows;
}

module.exports = {
  FAUCET_LOCK_KEY, tierLimits, nextClaimCheck, reserve, markSent, markConfirmed, markFailed, releaseReservation, rowsToSettle, waiveClaims
};
