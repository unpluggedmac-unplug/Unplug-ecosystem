// Must come before any query: it decides how a DATE column is handed back.
// See src/pgTypes.js for why.
require('./pgTypes');

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('Warning: DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = pool;
