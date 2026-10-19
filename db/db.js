require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

// Setup config with fallback
let config = {};
if (connectionString) {
  config = {
    connectionString,
  };
} else {
  // If no env var, use explicit defaults (useful for local dev/testing if .env isn't loading right)
  config = {
    user: process.env.POSTGRES_USER || 'postgres',
    host: 'localhost',
    database: process.env.POSTGRES_DB || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    port: parseInt(process.env.DB_PORT || '5440'),
  };
}

const pool = new Pool({
  ...config,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

function getPool() {
  return pool;
}

async function getClient() {
  return await pool.connect();
}

function getPoolConfig() {
  return {
    connectionString: connectionString,
    user: process.env.POSTGRES_USER || 'postgres',
    host: 'localhost',
    database: process.env.POSTGRES_DB || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    port: parseInt(process.env.DB_PORT || '5440'),
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  };
}

async function testConnection() {
  try {
    const client = await getClient();
    const result = await client.query('SELECT NOW() as current_time');
    await client.release();
    return { success: true, currentTime: result.rows[0].current_time };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function closePool() {
  await pool.end();
}

module.exports = {
  getPool,
  getClient,
  getPoolConfig,
  testConnection,
  closePool,
  pool
};
