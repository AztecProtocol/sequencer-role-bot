const { Pool } = require('pg');

// Test files run in parallel. Each file gets its own empty database on the
// server that TEST_DATABASE_URL names, so the files cannot disturb each other.
async function createEmptyDatabase(serverUrl, name) {
  const admin = new Pool({ connectionString: serverUrl });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return serverUrl.replace(/\/[^/]+$/, `/${name}`);
}

module.exports = { createEmptyDatabase };
