#!/usr/bin/env node
'use strict';

// Non-destructive verifier for the Supabase -> Cloudflare migration.
//
// Usage:
//   node scripts/verify-cloudflare-migration.js
//   DATABASE_URL=<target-postgres-url> node scripts/verify-cloudflare-migration.js --target
//
// This script never modifies data. It answers two release-gate questions:
//  1) Does the selected Postgres database contain the expected Unplug schema?
//  2) Do application records still point directly at legacy Supabase Storage?
//
// A clean target database should have the expected schema and ZERO legacy
// Supabase Storage URL references before Supabase is decommissioned.

require('dotenv').config();
const { Pool } = require('pg');

const url = process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL or TARGET_DATABASE_URL is required.');
  process.exit(2);
}

const pool = new Pool({ connectionString: url, max: 2 });

function qident(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

async function main() {
  const schema = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE') AS public_tables,
      (SELECT count(*)::int FROM information_schema.routines
        WHERE routine_schema='public') AS public_routines,
      (SELECT count(*)::int FROM pg_trigger
        WHERE NOT tgisinternal) AS user_triggers,
      (SELECT count(*)::int FROM pg_indexes
        WHERE schemaname='public') AS public_indexes,
      (SELECT count(*)::int FROM information_schema.table_constraints
        WHERE constraint_schema='public' AND constraint_type='FOREIGN KEY') AS foreign_keys,
      (SELECT count(*)::int FROM information_schema.sequences
        WHERE sequence_schema='public') AS public_sequences
  `);

  const extensions = await pool.query(`
    SELECT extname FROM pg_extension ORDER BY extname
  `);

  const columns = await pool.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema='public'
       AND data_type IN ('text','character varying')
       AND (
         column_name LIKE '%url%'
         OR column_name LIKE '%image%'
         OR column_name LIKE '%photo%'
         OR column_name LIKE '%avatar%'
         OR column_name LIKE '%pdf%'
       )
     ORDER BY table_name, column_name
  `);

  let legacyReferences = 0;
  const legacyByColumn = [];
  for (const c of columns.rows) {
    const sql = `SELECT count(*)::int AS n FROM ${qident(c.table_name)} WHERE ${qident(c.column_name)} LIKE '%.supabase.co/storage/%'`;
    try {
      const r = await pool.query(sql);
      const n = Number(r.rows[0].n || 0);
      if (n > 0) {
        legacyReferences += n;
        legacyByColumn.push({ table: c.table_name, column: c.column_name, count: n });
      }
    } catch (err) {
      // A discovered URL-like column should normally be queryable. Report the
      // problem but do not hide the rest of the inventory.
      legacyByColumn.push({ table: c.table_name, column: c.column_name, error: err.message });
    }
  }

  const coreTables = [
    'users', 'articles', 'profiles', 'orders', 'payments',
    'growth_applications', 'agreement_forms', 'settings'
  ];
  const core = await pool.query(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name = ANY($1::text[])
  `, [coreTables]);
  const present = new Set(core.rows.map(r => r.table_name));
  const missingCore = coreTables.filter(t => !present.has(t));

  const report = {
    database: process.env.TARGET_DATABASE_URL ? 'target' : 'current',
    schema: schema.rows[0],
    extensions: extensions.rows.map(r => r.extname),
    missing_core_tables: missingCore,
    legacy_supabase_storage_references: legacyReferences,
    legacy_reference_columns: legacyByColumn,
  };

  console.log(JSON.stringify(report, null, 2));

  await pool.end();

  if (missingCore.length) {
    console.error(`FAIL: missing core tables: ${missingCore.join(', ')}`);
    process.exit(1);
  }
  if (legacyReferences > 0) {
    console.error(`NOT READY TO DECOMMISSION SUPABASE: ${legacyReferences} legacy Storage reference(s) remain.`);
    process.exit(3);
  }
  console.log('PASS: core schema present and no legacy Supabase Storage references remain.');
}

main().catch(async err => {
  console.error('Migration verification failed:', err.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
