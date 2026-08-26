#!/usr/bin/env node
//
// Copies production into a staging database.
//
//   node scripts/clone-to-staging.js            copy, with real member data
//   node scripts/clone-to-staging.js --scrub    copy, with personal data replaced
//
// WHY --scrub EXISTS, and why it is the one you probably want. A clone of this
// site's database contains every member's email address, every payment
// reference and every private message somebody sent through the contact form.
// Staging environments get shared, screenshotted, left running, and pointed at
// test email services that will happily send to real addresses. --scrub
// replaces the personal parts with obvious fakes so a staging accident is
// embarrassing rather than a data breach.
//
// IT ONLY EVER WRITES TO STAGING_DATABASE_URL. There is no flag to point this
// at production, because there is no version of "clone production over
// production" that anybody wants.

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const runner = require('../src/utils/backupRunner');
const backupCrypto = require('../src/utils/backupCrypto');

const SCRUB = process.argv.includes('--scrub');

async function main() {
  const source = process.env.DATABASE_URL;
  const target = process.env.STAGING_DATABASE_URL;

  if (!source) {
    console.error('DATABASE_URL is not set — there is nothing to copy from.');
    process.exit(1);
  }
  if (!target) {
    console.error(
      'STAGING_DATABASE_URL is not set.\n\n'
      + 'This script only ever writes to that variable, deliberately: there is no\n'
      + 'version of "clone production over production" that anybody wants. Create a\n'
      + 'staging database in Render, put its connection string in\n'
      + 'STAGING_DATABASE_URL, and run this again.');
    process.exit(1);
  }
  if (source === target) {
    console.error('DATABASE_URL and STAGING_DATABASE_URL are the same database. Stopping.');
    process.exit(1);
  }

  console.log(`Copying from ${new URL(source).host} to ${new URL(target).host}`);
  console.log(SCRUB ? 'Personal data WILL be replaced with fakes.\n'
                    : 'Personal data will be copied AS IS. Consider --scrub.\n');

  // Take a fresh backup of production. Reusing the nightly one would copy
  // whatever state it happened to catch, and somebody cloning to reproduce a
  // bug wants the state the bug is in.
  console.log('Taking a fresh backup of the source...');
  const { text } = await runner.buildDump();
  console.log(`  ${(text.length / 1024).toFixed(0)} KB of SQL.`);

  const pool = new Pool({ connectionString: target });

  console.log('Rebuilding the staging schema...');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }

  // The migrations seed reference rows that the dump also contains.
  const tables = await pool.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'`);
  await pool.query(
    `TRUNCATE ${tables.rows.map((r) => `"${r.relname}"`).join(', ')} RESTART IDENTITY CASCADE`);

  console.log('Loading...');
  await pool.query(text);

  if (SCRUB) {
    console.log('Replacing personal data...');
    // Emails become obviously fake but stay unique and valid, so anything that
    // sends mail in staging cannot reach a real person, and anything that
    // requires a unique email still works.
    await pool.query(`UPDATE users SET
        email = 'member' || id || '@staging.invalid',
        full_name = 'Test Member ' || id,
        -- A hash of nothing anybody knows: staging accounts cannot be signed
        -- into with a production password.
        password_hash = 'scrubbed-not-a-valid-hash',
        two_factor_secret = NULL, two_factor_enabled = false`);
    await pool.query(`UPDATE inquiries SET
        name = 'Scrubbed Enquiry', email = 'enquiry' || id || '@staging.invalid',
        message = '(removed from the staging copy)'`);
    // .invalid is reserved by RFC 2606 precisely so it can never be delivered.
    console.log('  emails now end .invalid, which cannot be delivered anywhere.');
  }

  const counts = await pool.query(`SELECT count(*)::int AS n FROM users`);
  console.log(`\nDone. Staging has ${counts.rows[0].n} users.`);
  if (!SCRUB) {
    console.log('\nThose are REAL email addresses. Make sure nothing in staging sends mail.');
  }
  await pool.end();
}

main().catch((err) => {
  console.error('\nThe clone stopped:', err.message);
  process.exit(1);
});
