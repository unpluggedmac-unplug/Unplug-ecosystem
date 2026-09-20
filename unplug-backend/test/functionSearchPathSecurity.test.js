// Security regression for migration 215.
//
// Supabase warns when application functions inherit a mutable search_path.
// The migration pins all public, non-extension functions to public + pg_temp.
// This test runs the real migration chain against PostgreSQL and proves a
// later migration cannot quietly reintroduce an unpinned application function.
//
// Run with: npm test (from unplug-backend/)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-search-path-'));
const port = 54400 + (process.pid % 300);

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: `postgres://postgres:postgres@localhost:${port}/unplug_test` });

  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  for (const file of fs.readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
});

after(async () => {
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('all public application functions have an explicit safe search_path', async () => {
  const r = await pool.query(`
    SELECT p.oid::regprocedure::text AS signature, p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND NOT EXISTS (
         SELECT 1
           FROM pg_depend d
           JOIN pg_extension e ON e.oid = d.refobjid
          WHERE d.classid = 'pg_proc'::regclass
            AND d.objid = p.oid
            AND d.deptype = 'e'
       )
       AND (
         p.proconfig IS NULL
         OR NOT EXISTS (
           SELECT 1
             FROM unnest(p.proconfig) cfg
            WHERE cfg = 'search_path=public, pg_temp'
         )
       )
     ORDER BY 1
  `);

  assert.deepEqual(r.rows, [], 'application functions must pin search_path to public, pg_temp');
});

test('migration 215 is safe to run repeatedly', async () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '215_function_search_path_hardening.sql'),
    'utf8'
  );
  await pool.query(sql);
  await pool.query(sql);

  const r = await pool.query(`
    SELECT COUNT(*)::int AS n
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND NOT EXISTS (
         SELECT 1
           FROM pg_depend d
           JOIN pg_extension e ON e.oid = d.refobjid
          WHERE d.classid = 'pg_proc'::regclass
            AND d.objid = p.oid
            AND d.deptype = 'e'
       )
       AND EXISTS (
         SELECT 1
           FROM unnest(p.proconfig) cfg
          WHERE cfg = 'search_path=public, pg_temp'
       )
  `);
  assert.ok(r.rows[0].n > 0, 'the migration should harden real application functions');
});


test('migration 216 tolerates managed-provider extension ownership without swallowing unrelated errors', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '216_pg_trgm_extension_schema.sql'),
    'utf8'
  );
  assert.match(sql, /ALTER EXTENSION pg_trgm SET SCHEMA extensions/i);
  assert.match(sql, /EXCEPTION\s+WHEN\s+insufficient_privilege/i);
  assert.doesNotMatch(sql, /WHEN\s+OTHERS/i, 'migration must not hide arbitrary database failures');
});

test('pg_trgm is not installed in the public schema when available', async () => {
  const r = await pool.query(`
    SELECT n.nspname AS schema
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'pg_trgm'
  `);
  if (!r.rowCount) return; // embedded-postgres CI build does not ship pg_trgm
  assert.equal(r.rows[0].schema, 'extensions');
});
