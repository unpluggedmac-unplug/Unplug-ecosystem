// Applies every db/migrations/*.sql file in order, then seeds a single
// admin account. Run with: npm run migrate
//
// Admin credentials come from environment variables so no real password
// ever lives in source control:
//   ADMIN_EMAIL    (defaults to admin@unplugnews.com)
//   ADMIN_PASSWORD (required — migration exits if this is missing)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filenames are zero-padded (001_, 002_...) so plain sort works

  for (const file of files) {
    console.log(`Applying ${file}...`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
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
