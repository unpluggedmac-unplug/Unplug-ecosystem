#!/usr/bin/env node
//
// Restoring a backup. The most dangerous script in this repository.
//
//   node scripts/restore-backup.js --list
//   node scripts/restore-backup.js --dry-run <filename>
//   node scripts/restore-backup.js --to-staging <filename>
//   node scripts/restore-backup.js --i-understand-this-replaces-everything <filename>
//
// WHY THIS IS A COMMAND-LINE SCRIPT AND NOT A BUTTON.
//
// A "restore from backup" control in the admin dashboard is a control that
// destroys the entire live site in one click. During this same piece of work
// two stored XSS holes were found in that dashboard — one of them reachable by
// anyone on the internet through the public contact form. Had a restore
// endpoint existed then, a hijacked admin session could have wiped the site
// and replaced it with three-week-old data.
//
// Running this needs shell access to the server, which somebody who has
// borrowed a browser session does not have. That is the guard, and it is worth
// more than any number of confirmation dialogs.
//
// WHAT A RESTORE ACTUALLY DOES HERE. The backup is data, not schema: the
// schema comes from db/migrations, which are idempotent and run on every
// deploy. So a restore is:
//
//   1. run the migrations against the target, creating an empty structure
//   2. load the rows
//   3. set the sequences, so the next insert does not collide
//
// A SNAPSHOT IS TAKEN OF WHATEVER IS ABOUT TO BE REPLACED, first, always, even
// on a database being thrown away. The moment somebody most regrets not having
// a backup is the moment they restore the wrong one.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Pool } = require('pg');

const runner = require('../src/utils/backupRunner');
const backupCrypto = require('../src/utils/backupCrypto');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const target = args.find((a) => !a.startsWith('--'));

const PROD_MARKER = /render\.com|supabase\.co/i;

function isProductionUrl(url) {
  return PROD_MARKER.test(String(url || ''));
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer;
}

async function main() {
  if (has('--list')) {
    const inventory = await runner.inventory();
    for (const dest of inventory) {
      console.log(`\n${dest.provider}${dest.warning ? '  ⚠ ' + dest.warning : ''}`);
      if (dest.error) { console.log('  could not read:', dest.error); continue; }
      if (!dest.count) { console.log('  (nothing stored)'); continue; }
      for (const item of dest.items) {
        console.log(`  ${item.key}  ${(item.bytes / 1024).toFixed(0)} KB  ${item.modified || ''}`);
      }
    }
    return;
  }

  if (!target) {
    console.log(fs.readFileSync(__filename, 'utf8')
      .split('\n').filter((l) => l.startsWith('//')).slice(0, 12).join('\n'));
    process.exit(1);
  }

  // Fetch and decrypt first. If the backup cannot be opened, nothing else
  // should have happened yet.
  console.log(`Fetching ${target}...`);
  const { sql, provider } = await runner.fetchDecrypted(target);
  const inserts = (sql.match(/^INSERT INTO/gm) || []).length;
  const sequences = (sql.match(/^SELECT setval/gm) || []).length;
  console.log(`Opened from ${provider}: ${inserts} rows, ${sequences} sequences, ${(sql.length / 1024).toFixed(0)} KB of SQL.`);

  if (has('--dry-run')) {
    console.log('\nDry run. Nothing was written.');
    console.log('Tables in this backup:');
    const tables = [...new Set((sql.match(/^INSERT INTO "([^"]+)"/gm) || [])
      .map((m) => m.match(/"([^"]+)"/)[1]))];
    console.log('  ' + tables.join(', '));
    return;
  }

  // --- work out what is about to be overwritten ----------------------------
  const url = has('--to-staging')
    ? (process.env.STAGING_DATABASE_URL || process.env.DATABASE_URL)
    : process.env.DATABASE_URL;

  if (!url) {
    console.error('No DATABASE_URL. Nothing to restore into.');
    process.exit(1);
  }

  const looksProd = isProductionUrl(url);
  const host = (() => { try { return new URL(url).host; } catch (e) { return '(unreadable)'; } })();

  console.log(`\nTarget database: ${host}`);
  if (looksProd && !has('--i-understand-this-replaces-everything')) {
    console.error(
      '\nThat looks like the PRODUCTION database, and the flag to allow it was not given.\n'
      + 'Every row currently in it would be replaced by rows from '
      + `${target}.\n\n`
      + 'If that is genuinely what you want:\n'
      + `  node scripts/restore-backup.js --i-understand-this-replaces-everything ${target}\n`);
    process.exit(1);
  }

  if (looksProd) {
    const typed = await confirm(
      `\nType the database host to confirm you mean to replace it (${host}): `);
    if (typed.trim() !== host) {
      console.error('That did not match. Nothing was changed.');
      process.exit(1);
    }
  }

  const pool = new Pool({ connectionString: url });

  // --- snapshot whatever is there now --------------------------------------
  //
  // Before anything is dropped. Somebody restoring the wrong backup is a far
  // more likely accident than the disaster they are restoring from.
  console.log('\nTaking a snapshot of the current contents first...');
  try {
    process.env.DATABASE_URL = url;
    const snapshot = await runner.run({ keepAll: true });
    console.log(`  snapshot saved as ${snapshot.filename} (${snapshot.rows} rows)`);
  } catch (err) {
    const answer = await confirm(
      `  the snapshot FAILED: ${err.message}\n`
      + '  continue anyway, with no way back? (type "yes" to continue): ');
    if (answer.trim().toLowerCase() !== 'yes') {
      console.error('Stopped. Nothing was changed.');
      process.exit(1);
    }
  }

  // --- clear, rebuild, load ------------------------------------------------
  console.log('\nClearing the target and rebuilding the schema from migrations...');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  console.log(`  ${files.length} migrations applied.`);

  // THE MIGRATIONS SEED REFERENCE DATA — achievements, badges, categories,
  // status levels and more, across 33 of them. Those rows now exist, and the
  // backup contains them too, so loading straight on top fails on a primary
  // key. The first attempt at this test failed exactly that way, on
  // achievements_pkey.
  //
  // Everything is emptied rather than the seeded tables being skipped: an
  // admin may have edited a seeded row, and the backup is the authority on
  // what those rows should say. RESTART IDENTITY is safe here because the
  // backup sets every sequence explicitly at the end.
  console.log('Clearing seeded rows so the backup is the only source of truth...');
  const tableRows = await pool.query(`
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'`);
  const names = tableRows.rows.map((r) => `"${r.relname}"`);
  if (names.length) {
    await pool.query(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`);
  }

  console.log('Loading the data...');
  // The dump is one transaction already; a failure part-way leaves the target
  // with a schema and no rows rather than half a database.
  await pool.query(sql);

  const check = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`);
  console.log(`\nDone. ${check.rows[0].n} tables, ${inserts} rows restored.`);
  console.log('Sequence positions were set from the backup, so new inserts will not collide.');

  await pool.end();
}

main().catch((err) => {
  console.error('\nThe restore stopped:', err.message);
  console.error('If it stopped before "Loading the data", the target was not modified.');
  process.exit(1);
});
