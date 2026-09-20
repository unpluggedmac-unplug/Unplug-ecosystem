// Applies every db/migrations/*.sql file in order, then seeds a single
// admin account. Run with: npm run migrate
//
// Admin credentials come from environment variables so no real password
// ever lives in source control:
//   ADMIN_EMAIL    (defaults to admin@unplugnews.com)
//   ADMIN_PASSWORD (required — migration exits if this is missing)

require('dotenv').config();
// Same DATE handling as the app, so a migration and a request can never
// disagree about what day it is. See src/pgTypes.js.
require('../src/pgTypes');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// PostgreSQL can abort one participant when two otherwise-valid operations take
// locks in opposite order. That is a retryable concurrency event, not a broken
// migration. Production deploys re-run the idempotent migrations while the old
// instance is still serving traffic, so a DDL migration can legitimately meet
// a live read/write at exactly the wrong moment.
//
// Retry ONLY the PostgreSQL errors explicitly documented as transaction-retry
// conditions. Syntax errors, missing objects, constraint failures, permissions,
// and every other SQL problem still fail the deploy immediately.
const RETRYABLE_MIGRATION_CODES = new Set(['40P01', '40001']);
const MIGRATION_MAX_ATTEMPTS = 4;
const MIGRATION_RETRY_MS = [250, 750, 1500];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyMigration(file, sql) {
  for (let attempt = 1; attempt <= MIGRATION_MAX_ATTEMPTS; attempt += 1) {
    try {
      await pool.query(sql);
      return;
    } catch (err) {
      const retryable = RETRYABLE_MIGRATION_CODES.has(err && err.code);
      if (!retryable || attempt === MIGRATION_MAX_ATTEMPTS) throw err;

      const waitMs = MIGRATION_RETRY_MS[attempt - 1];
      console.warn(
        `Migration ${file} hit retryable PostgreSQL error ${err.code}; `
        + `retrying in ${waitMs}ms (attempt ${attempt + 1}/${MIGRATION_MAX_ATTEMPTS}).`
      );
      await sleep(waitMs);
    }
  }
}

async function run() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filenames are zero-padded (001_, 002_...) so plain sort works

  for (const file of files) {
    console.log(`Applying ${file}...`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await applyMigration(file, sql);
  }
  console.log('All migrations applied.');

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@unplugnews.com';
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    console.log('ADMIN_PASSWORD not set — skipping admin seed. Set it in .env and re-run to create the admin account.');
    await pool.end();
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 10);

  // By default we only create the admin if it doesn't exist yet, so a
  // redeploy never clobbers a password set elsewhere. Setting
  // ADMIN_PASSWORD_RESET=true is a deliberate one-time switch that forces the
  // admin's password to ADMIN_PASSWORD (used to recover a forgotten password).
  // Turn it back off (remove the var) after the reset so future deploys don't
  // keep resetting the password.
  const forceReset = String(process.env.ADMIN_PASSWORD_RESET || '').toLowerCase() === 'true';

  await pool.query(
    `INSERT INTO users (email, password_hash, role, email_verified)
     VALUES ($1, $2, 'admin', true)
     ON CONFLICT (email) DO ${forceReset ? 'UPDATE SET password_hash = EXCLUDED.password_hash, role = \'admin\', email_verified = true' : 'NOTHING'}`,
    [adminEmail, passwordHash]
  );

  console.log(
    forceReset
      ? `Admin password RESET for ${adminEmail} (ADMIN_PASSWORD_RESET was true — remember to remove that var now).`
      : `Admin account ready for ${adminEmail} (password not logged).`
  );
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
