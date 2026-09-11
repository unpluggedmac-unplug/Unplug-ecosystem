#!/usr/bin/env node
'use strict';

// Read-only cutover gate for the Supabase -> Cloudflare R2 migration.
//
// Usage:
//   node scripts/verify-supabase-storage-exit.js
//
// This script NEVER updates or deletes data. It scans every text/varchar
// column in the public schema and counts values that still reference Supabase
// Storage. It exits non-zero while even one legacy reference remains, so the
// old Supabase Storage project cannot be treated as safe to decommission just
// because a migration command completed without throwing.

const pool = require('../src/db');

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function textColumns() {
  const result = await pool.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('text', 'character varying')
     ORDER BY table_name, ordinal_position`);
  return result.rows;
}

async function main() {
  console.log('Supabase Storage exit verification — READ ONLY.');
  const columns = await textColumns();
  const hits = [];
  let unreadable = 0;

  for (const { table_name: table, column_name: column } of columns) {
    const sql = `
      SELECT count(*)::int AS n
        FROM ${quoteIdent(table)}
       WHERE ${quoteIdent(column)} LIKE '%.supabase.co/storage/%'`;
    try {
      const result = await pool.query(sql);
      const count = Number(result.rows[0]?.n || 0);
      if (count > 0) hits.push({ table, column, count });
    } catch (err) {
      unreadable++;
      console.error(`UNREADABLE ${table}.${column}: ${err.message}`);
    }
  }

  const total = hits.reduce((sum, item) => sum + item.count, 0);
  console.log(`Text/varchar columns checked: ${columns.length}`);
  console.log(`Columns still containing Supabase Storage references: ${hits.length}`);
  console.log(`Total legacy Supabase Storage references: ${total}`);

  for (const item of hits) {
    console.log(`PENDING ${item.table}.${item.column}: ${item.count}`);
  }

  if (unreadable > 0) {
    console.error(`BLOCKED: ${unreadable} column(s) could not be verified. Decommissioning is not safe.`);
    process.exitCode = 2;
  } else if (total > 0) {
    console.error(`BLOCKED: ${total} legacy Supabase Storage reference(s) remain. Keep Supabase available as the source/rollback layer.`);
    process.exitCode = 1;
  } else {
    console.log('PASS: zero Supabase Storage references remain in public text/varchar columns.');
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('Verification failed:', err.message);
  try { await pool.end(); } catch (_) {}
  process.exit(2);
});
