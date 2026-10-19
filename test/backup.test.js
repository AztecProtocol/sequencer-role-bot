const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { createEmptyDatabase } = require('./helpers/database.js');

// Needs a disposable Postgres (see README) and pg_dump, psql and gzip on PATH.
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL is not set';
const script = path.join(__dirname, '..', 'scripts', 'backup.sh');

let sourceUrl;

function runBackup(dir, env = {}) {
  return spawnSync('sh', [script], {
    env: { PATH: process.env.PATH, DATABASE_URL: sourceUrl, BACKUP_DIR: dir, BACKUP_KEEP: '3', ...env },
    encoding: 'utf8'
  });
}

function backups(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.sql.gz')).sort();
}

test('database backup to a local directory', { skip }, async (t) => {
  sourceUrl = await createEmptyDatabase(url, 'bot_backup_source');
  const pool = new Pool({ connectionString: sourceUrl });
  t.after(() => pool.end());
  await require('../db/migrate.js').migrate(pool);
  await pool.query(
    `INSERT INTO pending_registrations (discord_user_id, network, wallet_address, message_to_sign, expires_at)
     VALUES ('4242', 'Mainnet', '0xBACKUPMARKER', 'm', NOW())`
  );

  await t.test('the dump restores the stored registrations into an empty database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-backup-'));
    const run = runBackup(dir);
    assert.equal(run.status, 0, run.stderr);
    const files = backups(dir);
    assert.equal(files.length, 1);

    const restoreUrl = await createEmptyDatabase(url, 'bot_backup_restore');
    execFileSync('sh', ['-c', 'gunzip -c "$1" | psql -q "$2"', 'sh', path.join(dir, files[0]), restoreUrl], { stdio: 'ignore' });

    const restored = new Pool({ connectionString: restoreUrl });
    const { rows } = await restored.query('SELECT discord_user_id FROM pending_registrations WHERE wallet_address = $1', ['0xBACKUPMARKER']);
    await restored.end();
    assert.deepEqual(rows, [{ discord_user_id: '4242' }]);
  });

  await t.test('only the owner can read a dump file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-backup-'));
    runBackup(dir);
    const mode = fs.statSync(path.join(dir, backups(dir)[0])).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  await t.test('the newest three dumps are kept and older dumps are deleted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-backup-'));
    const old = ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04'].map((day) => `aztec-bot-backup-${day}T03-00-00Z.sql.gz`);
    for (const name of old) fs.writeFileSync(path.join(dir, name), 'old');

    const run = runBackup(dir);
    assert.equal(run.status, 0, run.stderr);

    const kept = backups(dir);
    assert.equal(kept.length, 3);
    assert.deepEqual(kept.slice(0, 2), old.slice(2));
    assert.ok(!old.includes(kept[2]), 'the new dump is one of the three');
  });

  await t.test('a failed dump leaves no file and deletes no older dump', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-backup-'));
    const old = ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04'].map((day) => `aztec-bot-backup-${day}T03-00-00Z.sql.gz`);
    for (const name of old) fs.writeFileSync(path.join(dir, name), 'old');

    const run = runBackup(dir, { DATABASE_URL: 'postgresql://postgres:wrong@127.0.0.1:1/none' });

    assert.notEqual(run.status, 0);
    assert.deepEqual(fs.readdirSync(dir).sort(), old);
  });
});
