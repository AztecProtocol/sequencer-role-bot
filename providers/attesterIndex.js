// Index of the attesters that each provider staked (StakedWithProvider), and
// the check that a provider has at least one validating attester.
const MAX_RANGE = 3900;

async function syncProviderAttesters(pool, network, chain) {
  const contract = chain.registryAddress.toLowerCase();
  const cursor = await pool.query(
    'SELECT last_block FROM event_cursors WHERE network = $1 AND contract = $2', [network, contract]
  );
  let from = cursor.rows.length ? Number(cursor.rows[0].last_block) + 1 : chain.startBlock;
  const latest = await chain.latestBlock();
  let size = MAX_RANGE;

  while (from <= latest) {
    const to = Math.min(from + size - 1, latest);
    let logs;
    try {
      logs = await chain.getStakeLogs(from, to);
    } catch (error) {
      if (size === 1) throw error;
      size = Math.max(1, Math.floor(size / 2));
      continue;
    }

    // Store the rows and the cursor together, so a failed run resumes here.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const log of logs) {
        await client.query(
          'INSERT INTO provider_attesters (network, registry, provider_id, attester) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [network, contract, log.providerId, log.attester.toLowerCase()]
        );
      }
      await client.query(
        `INSERT INTO event_cursors (network, contract, last_block) VALUES ($1, $2, $3)
         ON CONFLICT (network, contract) DO UPDATE SET last_block = GREATEST(event_cursors.last_block, EXCLUDED.last_block)`,
        [network, contract, to]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    from = to + 1;
  }
}

async function isProviderActive(pool, network, providerId, chain) {
  const { rows } = await pool.query(
    'SELECT attester FROM provider_attesters WHERE network = $1 AND registry = $2 AND provider_id = $3 ORDER BY attester',
    [network, chain.registryAddress.toLowerCase(), providerId]
  );
  for (const { attester } of rows) {
    if (await chain.isValidating(attester)) return true;
  }
  return false;
}

module.exports = { syncProviderAttesters, isProviderActive, MAX_RANGE };
