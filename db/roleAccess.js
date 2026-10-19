// Decides if a user must keep the sequencer role for a network.
// A user keeps the role through an own operator or provider registration in
// use, or as an active colleague of a manager whose registration is in use.

const IN_USE = "('completed', 'at_risk')";

function storedNetworkName(network) {
  const name = String(network).toLowerCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

async function keepsRole(pool, userId, network) {
  const { rows } = await pool.query(
    `SELECT 1 FROM pending_registrations
       WHERE discord_user_id = $1 AND network = $2 AND status IN ${IN_USE}
     UNION ALL
     SELECT 1 FROM provider_registrations
       WHERE discord_user_id = $1 AND network = $2 AND status IN ${IN_USE}
     UNION ALL
     SELECT 1 FROM colleagues c
       JOIN pending_registrations r ON r.discord_user_id = c.manager_discord_id
       WHERE c.colleague_user_id = $1 AND c.status = 'active'
         AND r.network = $2 AND r.status IN ${IN_USE}
     UNION ALL
     SELECT 1 FROM colleagues c
       JOIN provider_registrations p ON p.discord_user_id = c.manager_discord_id
       WHERE c.colleague_user_id = $1 AND c.status = 'active'
         AND p.network = $2 AND p.status IN ${IN_USE}
     LIMIT 1`,
    [userId, storedNetworkName(network)]
  );
  return rows.length > 0;
}

// Networks (stored names, for example 'Mainnet') in which a manager has a
// completed operator or provider registration.
async function managerNetworks(pool, managerId) {
  const { rows } = await pool.query(
    `SELECT network FROM pending_registrations WHERE discord_user_id = $1 AND status = 'completed'
     UNION
     SELECT network FROM provider_registrations WHERE discord_user_id = $1 AND status = 'completed'
     ORDER BY network`,
    [managerId]
  );
  return rows.map((row) => row.network);
}

module.exports = { keepsRole, managerNetworks };
