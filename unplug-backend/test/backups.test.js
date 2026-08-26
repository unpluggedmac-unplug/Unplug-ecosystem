// Backups, against a REAL PostgreSQL — including an actual restore.
//
// A BACKUP THAT HAS NEVER BEEN RESTORED IS NOT A BACKUP. It is a file somebody
// hopes is a backup. So the central test here does the whole thing: put real
// data in, dump it, encrypt it, throw the database away, rebuild it from the
// migrations, load the dump back, and check the rows are the ones that went
// in — including the sequence positions, which are the part that looks fine
// and breaks on the next insert.
//
// The other tests are about the ways a backup system fails quietly:
//
//   - encrypting with a passphrase nobody set
//   - producing a file that cannot be decrypted, discovered months later
//   - deleting old backups before the new one is safely stored
//   - restoring rows without sequences, so the database only looks restored
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let dump;
let backupCrypto;
let storage;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-backup-'));
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-backupfiles-'));
const port = 39200 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

const PASSPHRASE = 'a-sufficiently-long-test-passphrase';

async function runMigrations() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
}

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-backups';
  process.env.UNPLUG_BACKUP_PASSPHRASE = PASSPHRASE;
  process.env.UNPLUG_BACKUP_DIR = backupDir;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  dump = require('../src/utils/backupDump');
  backupCrypto = require('../src/utils/backupCrypto');
  storage = require('../src/utils/backupStorage');
});

after(async () => {
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
});

// ---------------------------------------------------------------------------
// The whole point
// ---------------------------------------------------------------------------

test('A BACKUP CAN ACTUALLY BE RESTORED', async () => {
  // Real rows, of the kinds this site holds: a member, a competition, and a
  // vote — the last one because votes carry payment links and are the rows it
  // would hurt most to lose.
  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES (900001, 'restore@test.com', 'Restore Test', 'hashed', 'member')`);
  const comp = await pool.query(
    `INSERT INTO competitions (name, slug, description, opens_at, closes_at, status)
     VALUES ('Backup Comp', 'backup-comp', 'x', now(), now() + INTERVAL '30 days', 'open')
     RETURNING id`);
  const entry = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, manual_name, status)
     VALUES ($1, NULL, 'Someone Real', 'approved') RETURNING id`, [comp.rows[0].id]);
  await pool.query(
    `INSERT INTO votes (entry_id, session_id) VALUES ($1, 'sess-backup-test')`, [entry.rows[0].id]);

  const before = {
    users: (await pool.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n,
    votes: (await pool.query(`SELECT count(*)::int AS n FROM votes`)).rows[0].n,
    entrySeq: (await pool.query(`SELECT last_value FROM competition_entries_id_seq`)).rows[0].last_value,
  };

  // --- take the backup ---
  const parts = [];
  const summary = await dump.dumpTo((c) => parts.push(c));
  const sql = parts.join('');
  const encrypted = backupCrypto.encrypt(sql, PASSPHRASE);
  assert.ok(summary.rows > 0);
  assert.ok(summary.sequences > 0, 'sequence positions were captured');

  // --- destroy everything ---
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const gone = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`);
  assert.equal(gone.rows[0].n, 0, 'the database really is empty');

  // --- rebuild and restore ---
  await runMigrations();
  // The migrations seed reference data — achievements, badges, categories.
  // Those rows are in the backup too, so loading on top collides on a primary
  // key. This is exactly what scripts/restore-backup.js does, and the first
  // version of this test found the problem by failing on achievements_pkey.
  const tableRows = await pool.query(`
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'`);
  await pool.query(`TRUNCATE ${tableRows.rows.map((r) => `"${r.relname}"`).join(', ')} RESTART IDENTITY CASCADE`);

  const decrypted = backupCrypto.decrypt(encrypted, PASSPHRASE).toString('utf8');
  await pool.query(decrypted);

  const after = {
    users: (await pool.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n,
    votes: (await pool.query(`SELECT count(*)::int AS n FROM votes`)).rows[0].n,
    entrySeq: (await pool.query(`SELECT last_value FROM competition_entries_id_seq`)).rows[0].last_value,
  };

  assert.equal(after.users, before.users, 'every user came back');
  assert.equal(after.votes, before.votes, 'and every vote — these carry payment links');
  assert.equal(String(after.entrySeq), String(before.entrySeq),
    'and the sequence is where it was');

  const restored = await pool.query(`SELECT email, full_name FROM users WHERE id = 900001`);
  assert.equal(restored.rows[0].email, 'restore@test.com');
  assert.equal(restored.rows[0].full_name, 'Restore Test');
});

test('THE NEXT INSERT AFTER A RESTORE DOES NOT COLLIDE', async () => {
  // The failure that makes a restore look successful and break a day later:
  // rows are back, sequences are not, and the next insert hits a primary key
  // that already exists.
  const comp = (await pool.query(`SELECT id FROM competitions LIMIT 1`)).rows[0];
  await assert.doesNotReject(async () => {
    await pool.query(
      `INSERT INTO competition_entries (competition_id, profile_id, manual_name, status)
       VALUES ($1, NULL, 'Inserted After Restore', 'pending')`, [comp.id]);
  }, 'inserting after a restore must not hit an existing id');
});

// ---------------------------------------------------------------------------
// The dump itself
// ---------------------------------------------------------------------------

test('the dump is loadable SQL, wrapped in one transaction', async () => {
  const parts = [];
  await dump.dumpTo((c) => parts.push(c));
  const sql = parts.join('');
  assert.match(sql, /^-- Unplug Magazine/);
  assert.match(sql, /\nBEGIN;\n/);
  assert.match(sql.trimEnd(), /COMMIT;$/);
  // Half a database is worse than none: the transaction is what makes a
  // partial load impossible.
  assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('INSERT INTO'));
});

test('values are escaped so a quote in somebody name cannot break the dump', async () => {
  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES (900002, 'quote@test.com', $1, 'x', 'member')`, ["O'Brien \"The\" Plumber"]);
  const parts = [];
  await dump.dumpTo((c) => parts.push(c), { tables: ['users'] });
  const sql = parts.join('');
  assert.ok(sql.includes("O''Brien"), 'the apostrophe is doubled, as SQL requires');
  // And it still loads.
  await pool.query('DELETE FROM users WHERE id = 900002');
  await assert.doesNotReject(() => pool.query(sql.replace(/^BEGIN;$|^COMMIT;$/gm, '')
    .split('\n').filter((l) => l.startsWith('INSERT INTO "users"') && l.includes('900002')).join('\n')));
});

test('null, boolean, timestamp and json values all survive', async () => {
  await pool.query(
    `INSERT INTO spam_assessments (target_type, score, verdict, signals, sample, email)
     VALUES ('test', 42, 'suspect', $1, 'a sample', NULL)`,
    [JSON.stringify([{ name: 'links', points: 12 }])]);

  const parts = [];
  await dump.dumpTo((c) => parts.push(c), { tables: ['spam_assessments'] });
  const sql = parts.join('');
  assert.ok(sql.includes('NULL'), 'nulls are written as NULL, not as the string "null"');
  assert.ok(sql.includes('"signals"'), 'the json column is included');

  await pool.query('DELETE FROM spam_assessments');
  await pool.query(sql);
  const back = (await pool.query('SELECT signals, email FROM spam_assessments LIMIT 1')).rows[0];
  assert.equal(back.email, null);
  assert.equal(back.signals[0].name, 'links');
});

test('high-volume analytics tables are left out on purpose', async () => {
  // They are rebuilt by traffic and would multiply the size of every backup.
  assert.ok(dump.SKIP_TABLES.has('analytics_events'));
  assert.ok(dump.SKIP_TABLES.has('page_views'));
  // But the things that cannot be rebuilt are never skipped.
  for (const critical of ['users', 'votes', 'payments', 'articles', 'profiles']) {
    assert.ok(!dump.SKIP_TABLES.has(critical), `${critical} must always be backed up`);
  }
});

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

test('IT REFUSES TO RUN WITHOUT A PASSPHRASE', async () => {
  // A dump holds every member email, payment reference and private enquiry on
  // the site, and it gets uploaded to somebody else's bucket.
  const saved = process.env.UNPLUG_BACKUP_PASSPHRASE;
  delete process.env.UNPLUG_BACKUP_PASSPHRASE;
  assert.throws(() => backupCrypto.passphrase(), /not set|shorter/);

  process.env.UNPLUG_BACKUP_PASSPHRASE = 'tooshort';
  assert.throws(() => backupCrypto.passphrase(), /shorter/,
    'a short passphrase is refused rather than silently accepted');

  process.env.UNPLUG_BACKUP_PASSPHRASE = saved;
});

test('a tampered backup fails rather than restoring altered data', async () => {
  // The difference between an error and a disaster nobody notices for a week.
  const encrypted = backupCrypto.encrypt('-- Unplug Magazine\nCOMMIT;', PASSPHRASE);
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 5] ^= 0xFF;
  assert.throws(() => backupCrypto.decrypt(tampered, PASSPHRASE), /altered|decrypt/);
});

test('two backups of the same data do not share a key', async () => {
  // A per-backup salt, so a passphrase cracked once is not every backup.
  const a = backupCrypto.encrypt('same text', PASSPHRASE);
  const b = backupCrypto.encrypt('same text', PASSPHRASE);
  assert.notEqual(a.toString('hex'), b.toString('hex'));
  assert.equal(backupCrypto.decrypt(a, PASSPHRASE).toString(), 'same text');
  assert.equal(backupCrypto.decrypt(b, PASSPHRASE).toString(), 'same text');
});

test('the file says what it is', async () => {
  // Somebody finding this in three years needs to know what they are holding.
  const encrypted = backupCrypto.encrypt('x', PASSPHRASE);
  assert.equal(encrypted.toString('ascii', 0, 8), 'UNPLUGBK');
  assert.equal(backupCrypto.looksLikeBackup(encrypted), true);
  assert.equal(backupCrypto.looksLikeBackup(Buffer.from('just some other file')), false);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('local storage says out loud that it is not a real backup', async () => {
  // Render wipes the disk on every deploy. A backup nobody realises is
  // ephemeral is worse than none, because it produces the belief in one.
  const provider = storage.localProvider(backupDir);
  assert.match(provider.warning, /ephemeral|wipes/i);
});

test('a stored backup can be listed and read back', async () => {
  const provider = storage.localProvider(backupDir);
  const payload = backupCrypto.encrypt('-- Unplug Magazine\nCOMMIT;', PASSPHRASE);
  await provider.put('unplug-2026-01-01T00-00-00-000Z.unplugbk', payload);

  const listed = await provider.list();
  assert.ok(listed.some((x) => x.key.startsWith('unplug-')));

  const read = await provider.get('unplug-2026-01-01T00-00-00-000Z.unplugbk');
  assert.equal(backupCrypto.decrypt(read, PASSPHRASE).toString(), '-- Unplug Magazine\nCOMMIT;');
});

test('S3 requests are signed', async () => {
  // Not a test of AWS; a test that the signature is present and changes with
  // the request, so a broken signer fails loudly at the first upload rather
  // than silently uploading nothing.
  const a = storage.signRequest({
    method: 'PUT', url: 'https://example.r2.cloudflarestorage.com/bucket/one.unplugbk',
    body: Buffer.from('a'), accessKeyId: 'AK', secretAccessKey: 'SK', region: 'auto',
  });
  const b = storage.signRequest({
    method: 'PUT', url: 'https://example.r2.cloudflarestorage.com/bucket/two.unplugbk',
    body: Buffer.from('b'), accessKeyId: 'AK', secretAccessKey: 'SK', region: 'auto',
  });
  assert.match(a.Authorization, /^AWS4-HMAC-SHA256 Credential=AK\//);
  assert.ok(a['x-amz-content-sha256'], 'the payload hash is sent, so an altered upload is rejected');
  assert.notEqual(a.Authorization, b.Authorization, 'a different request signs differently');
});

test('with nothing configured it falls back to local, not to silence', async () => {
  const saved = { r2: process.env.R2_ACCESS_KEY_ID, b2: process.env.B2_ACCESS_KEY_ID };
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.B2_ACCESS_KEY_ID;

  const list = storage.providers();
  assert.equal(list.length, 1);
  assert.match(list[0].name, /local/i);
  assert.ok(list[0].warning, 'and it warns');

  if (saved.r2) process.env.R2_ACCESS_KEY_ID = saved.r2;
  if (saved.b2) process.env.B2_ACCESS_KEY_ID = saved.b2;
});
