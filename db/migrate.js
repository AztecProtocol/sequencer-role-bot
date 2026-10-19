const fs = require('fs');
const path = require('path');

// Create the tables if they do not exist. Safe to run on every start.
async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

if (require.main === module) {
  const { pool } = require('./db.js');
  migrate(pool)
    .then(() => {
      console.log('Database schema is up to date.');
      return pool.end();
    })
    .catch(async (error) => {
      console.error('Database migration failed:', error.message);
      await pool.end();
      process.exit(1);
    });
}

module.exports = { migrate };
