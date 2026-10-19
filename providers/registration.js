// Provider registration without Discord: start (checks and the message) and
// complete (signature, signer, activity).
const { ethers } = require('ethers');
const chainModule = require('./chain.js');
const { eligibleSignerKind, providerExists } = require('./signers.js');
const { buildProviderMessage, verifyProviderSignature } = require('./message.js');
const { syncProviderAttesters, isProviderActive } = require('./attesterIndex.js');

const storedNetworkName = (network) => {
  const name = String(network).toLowerCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
};

async function startProviderRegistration(pool, { discordUserId, discordUsername, network, providerId, signer }) {
  const chain = chainModule.forNetwork(network);
  if (!chain) return { ok: false, reason: 'not_configured' };
  if (!/^\d+$/.test(String(providerId)) || !ethers.isAddress(String(signer))) return { ok: false, reason: 'invalid_input' };
  if (!(await providerExists(chain, Number(providerId)))) return { ok: false, reason: 'no_provider' };
  const kind = await eligibleSignerKind(chain, Number(providerId), signer);
  if (!kind) return { ok: false, reason: 'not_eligible' };

  const message = buildProviderMessage(discordUserId, Number(providerId), signer);
  // A registration in use keeps its signer. Any other state starts again.
  const { rows } = await pool.query(
    `INSERT INTO provider_registrations (
       discord_user_id, discord_username, network, registry, provider_id, signer_address, signer_kind, message_to_sign, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '24 hours')
     ON CONFLICT (discord_user_id, network, registry, provider_id) DO UPDATE SET
       discord_username = EXCLUDED.discord_username, signer_address = EXCLUDED.signer_address,
       signer_kind = EXCLUDED.signer_kind, message_to_sign = EXCLUDED.message_to_sign,
       expires_at = EXCLUDED.expires_at, status = 'pending', signature = NULL,
       at_risk_since = NULL, last_notification_status = NULL, updated_at = NOW()
     WHERE provider_registrations.status NOT IN ('completed', 'at_risk')
     RETURNING id`,
    [discordUserId, discordUsername, storedNetworkName(network), chain.registryAddress.toLowerCase(), Number(providerId), signer, kind, message]
  );
  if (rows.length === 0) {
    const existing = await pool.query(
      'SELECT status FROM provider_registrations WHERE discord_user_id = $1 AND network = $2 AND registry = $3 AND provider_id = $4',
      [discordUserId, storedNetworkName(network), chain.registryAddress.toLowerCase(), Number(providerId)]
    );
    return { ok: false, reason: 'in_use', status: existing.rows[0] && existing.rows[0].status };
  }
  return { ok: true, recordId: rows[0].id, message };
}

async function completeProviderRegistration(pool, { recordId, discordUserId, signature }) {
  if (!/^\d+$/.test(String(recordId))) return { ok: false, reason: 'not_found' };
  const { rows } = await pool.query(
    `SELECT * FROM provider_registrations
     WHERE id = $1 AND discord_user_id = $2 AND status IN ('pending', 'cancelled')`,
    [Number(recordId), discordUserId]
  );
  const record = rows[0];
  if (!record) return { ok: false, reason: 'not_found' };
  const setStatus = (status) =>
    pool.query('UPDATE provider_registrations SET status = $1, updated_at = NOW() WHERE id = $2', [status, record.id]);

  if (new Date(record.expires_at) < new Date()) {
    await setStatus('expired');
    return { ok: false, reason: 'expired' };
  }

  const verification = await verifyProviderSignature(record, signature, discordUserId);
  if (!verification.success && /expired/i.test(verification.error || '')) {
    await setStatus('expired');
    return { ok: false, reason: 'expired' };
  }
  if (!verification.success) {
    await setStatus('cancelled');
    return { ok: false, reason: 'bad_signature', error: verification.error };
  }

  const network = record.network.toLowerCase();
  const chain = chainModule.forNetwork(network);
  if (!chain) return { ok: false, reason: 'not_configured' };
  // A record started for a StakingRegistry that is no longer configured.
  if (record.registry !== chain.registryAddress.toLowerCase()) {
    await setStatus('cancelled');
    return { ok: false, reason: 'registry_changed' };
  }
  if (!(await eligibleSignerKind(chain, record.provider_id, record.signer_address))) {
    await setStatus('cancelled');
    return { ok: false, reason: 'not_eligible' };
  }

  await syncProviderAttesters(pool, network, chain);
  if (!(await isProviderActive(pool, network, record.provider_id, chain))) {
    await setStatus('cancelled');
    return { ok: false, reason: 'inactive' };
  }

  await pool.query(
    "UPDATE provider_registrations SET status = 'completed', signature = $1, updated_at = NOW() WHERE id = $2",
    [signature, record.id]
  );
  return { ok: true, network, providerId: record.provider_id };
}

module.exports = { startProviderRegistration, completeProviderRegistration };
