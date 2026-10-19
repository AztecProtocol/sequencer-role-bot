const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createEmptyDatabase } = require('./helpers/database.js');

// Needs a real, disposable Postgres. Example:
//   docker run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=bot_test \
//     -p 127.0.0.1:55440:5432 postgres:14
//   TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55440/bot_test npm test
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';

// The statements below are copied from bot.js, cronJob.js and
// db/signatureAttempts.js. They fail if the schema lacks a table or a
// column that the bot uses.
test('the bot statements run against a migrated empty database', { skip }, async (t) => {
  const pool = new Pool({ connectionString: await createEmptyDatabase(url, 'bot_schema_test') });
  t.after(() => pool.end());

  const { migrate } = require('../db/migrate.js');
  await migrate(pool);

  await t.test('a registration is stored with status pending', async () => {
    const inserted = await pool.query(
      `INSERT INTO pending_registrations (
         discord_user_id, discord_username, network, wallet_address, message_to_sign, expires_at
       ) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '24 hours') RETURNING id`,
      ['1001', 'alice', 'mainnet', '0x' + 'a'.repeat(40), 'msg']
    );
    const row = await pool.query(
      `SELECT id, discord_user_id, discord_username, network, wallet_address, message_to_sign, status, expires_at
       FROM pending_registrations
       WHERE id = $1 AND discord_user_id = $2 AND status IN ('pending', 'active', 'in_progress', 'cancelled')`,
      [inserted.rows[0].id, '1001']
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].status, 'pending');
  });

  await t.test('a registration records signature, retry state and notification state', async () => {
    const { rows } = await pool.query('SELECT id FROM pending_registrations LIMIT 1');
    await pool.query(
      'UPDATE pending_registrations SET signature = $1, status = $2, retry_count = $3, last_error = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5',
      ['0xsig', 'completed', 2, 'rpc timeout', rows[0].id]
    );
    await pool.query('UPDATE pending_registrations SET last_notification_status = $1 WHERE id = $2', ['HEALTHY', rows[0].id]);
    const listed = await pool.query(
      `SELECT id, discord_user_id, discord_username, network, wallet_address, status, created_at, last_notification_status
       FROM pending_registrations WHERE status IN ('completed', 'at_risk', 'expired') ORDER BY created_at DESC`
    );
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0].last_notification_status, 'HEALTHY');
    assert.ok(listed.rows[0].created_at instanceof Date);
  });

  await t.test('a signature attempt is counted for the day', async () => {
    const ts = 1791193440000; // 13-digit millisecond timestamp, exceeds 32-bit range
    await pool.query(
      `INSERT INTO signature_attempts (
         discord_user_id, discord_username, network, wallet_address, timestamp_generated, attempt_count
       ) VALUES ($1, $2, $3, $4, $5, 1) RETURNING attempt_count`,
      ['1001', 'alice', 'mainnet', '0x' + 'a'.repeat(40), ts]
    );
    const bumped = await pool.query(
      `UPDATE signature_attempts SET attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE discord_user_id = $1 AND network = $2 AND wallet_address = $3
         AND timestamp_generated = $4 AND created_at >= NOW() - INTERVAL '5 minutes'
       RETURNING attempt_count`,
      ['1001', 'mainnet', '0x' + 'a'.repeat(40), ts]
    );
    assert.equal(bumped.rows[0].attempt_count, 2);
    const today = await pool.query(
      `SELECT COUNT(*) as attempts_today FROM signature_attempts
       WHERE discord_user_id = $1 AND created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'`,
      ['1001']
    );
    assert.equal(today.rows[0].attempts_today, '1');
  });

  await t.test('a colleague is stored and can be set inactive', async () => {
    await pool.query(
      `INSERT INTO colleagues (manager_discord_id, manager_username, colleague_user_id, colleague_username, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
      ['1001', 'alice', '2002', 'bob']
    );
    const updated = await pool.query(
      `UPDATE colleagues SET status = $1, updated_at = NOW()
       WHERE manager_discord_id = $2 AND colleague_user_id = $3 RETURNING colleague_username`,
      ['inactive', '1001', '2002']
    );
    assert.equal(updated.rows[0].colleague_username, 'bob');
  });

  // bot.js handles error 23505 on this insert and updates the existing row.
  await t.test('a second registration for the same user and network is refused', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO pending_registrations (
           discord_user_id, discord_username, network, wallet_address, message_to_sign, expires_at
         ) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '24 hours') RETURNING id`,
        ['1001', 'alice', 'mainnet', '0x' + 'b'.repeat(40), 'msg2']
      ),
      { code: '23505' }
    );
  });

  await t.test('a provider registration is stored once for each user, network, registry and provider', async () => {
    let registry = '0x' + 'a'.repeat(40);
    const insert = () => pool.query(
      `INSERT INTO provider_registrations (
         discord_user_id, discord_username, network, registry, provider_id, signer_address, signer_kind, message_to_sign, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '24 hours') RETURNING id, status`,
      ['1001', 'alice', 'Mainnet', registry, 5, '0x' + 'c'.repeat(40), 'admin', 'msg']
    );
    const first = await insert();
    assert.equal(first.rows[0].status, 'pending');
    await assert.rejects(insert(), { code: '23505' });
    registry = '0x' + 'b'.repeat(40);
    await insert(); // a different StakingRegistry is a different registration
  });

  await t.test('a staked attester is indexed once, and the cursor never moves back', async () => {
    const add = () => pool.query(
      `INSERT INTO provider_attesters (network, registry, provider_id, attester) VALUES ('mainnet', '0xaa', 5, $1) ON CONFLICT DO NOTHING`,
      ['0x' + 'd'.repeat(40)]
    );
    await add();
    await add();
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM provider_attesters');
    assert.equal(rows[0].n, 1);

    const move = (block) => pool.query(
      `INSERT INTO event_cursors (network, contract, last_block) VALUES ('mainnet', '0xabc', $1)
       ON CONFLICT (network, contract) DO UPDATE SET last_block = GREATEST(event_cursors.last_block, EXCLUDED.last_block)`,
      [block]
    );
    await move(500);
    await move(300);
    const cursor = await pool.query('SELECT last_block FROM event_cursors');
    assert.equal(Number(cursor.rows[0].last_block), 500);
  });

  await t.test('a second migration keeps the stored rows', async () => {
    await migrate(pool);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pending_registrations');
    assert.equal(rows[0].n, 1);
  });
});
