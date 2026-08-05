// Editions management (Phase 1) — admin CRUD, publishing, and the homepage's
// "latest edition" lookup, over real HTTP against real PostgreSQL.
//
// Two things here are worth proving rather than assuming:
//   1. only Published editions reach the public, and the homepage picks the
//      newest one by DATE — that is what makes the homepage self-updating;
//   2. an edition someone has BOUGHT cannot be deleted. edition_purchases
//      CASCADEs from editions and carries payment_id, so deleting a purchased
//      edition erases the customer's proof of purchase.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;

let pg;
let pool;
let server;
let baseUrl;
let adminToken;
let memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-edtest-'));
const port = 7200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}

async function runMigrations() {
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }
}

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

const add = (over = {}) => req('POST', '/editions', {
  token: adminToken,
  body: {
    title: 'Test Edition', pdfUrl: 'https://example.test/e.pdf',
    month: 'August', year: 2026, publicationDate: '2026-08-01',
    status: 'published', ...over,
  },
});

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-editions-admin';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  const jwt = require('jsonwebtoken');
  adminToken = jwt.sign({ id: 1, email: 'admin@test', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 2, email: 'member@test', role: 'member' }, process.env.JWT_SECRET);

  // src/app.js can't be required: it listens and starts an interval on load.
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/editions', require('../src/routes/editions'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (pg) await pg.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ migration

test('existing editions survive the migration as published, with a date', async () => {
  // An edition created the old way (011's columns only) must not vanish from
  // the site because the new status column defaulted to something else.
  await pool.query(
    `INSERT INTO editions (issue_number, title, pdf_url, published_at)
     VALUES (900, 'Legacy Edition', 'https://example.test/legacy.pdf', '2026-05-01T00:00:00Z')`
  );
  await runMigrations(); // re-run, exactly as a deploy would
  const r = await pool.query(`SELECT status, publication_date, month, year FROM editions WHERE issue_number = 900`);
  assert.equal(r.rows[0].status, 'published');
  assert.equal(r.rows[0].year, 2026);
  assert.equal(r.rows[0].month, 'May');
  assert.ok(r.rows[0].publication_date, 'publication_date was not backfilled');
});

test('re-running migrations does NOT undo an admin status change', async () => {
  // migrate.js re-runs every migration on every deploy; the backfill must only
  // fill blanks or an unpublished edition would republish itself.
  await pool.query(`UPDATE editions SET status = 'archived' WHERE issue_number = 900`);
  await runMigrations();
  const r = await pool.query(`SELECT status FROM editions WHERE issue_number = 900`);
  assert.equal(r.rows[0].status, 'archived', 'the migration republished an archived edition');
});

// ---------------------------------------------------------------- permissions

test('members and visitors cannot manage editions', async () => {
  assert.equal((await req('GET', '/editions/admin/all', { token: memberToken })).status, 403);
  assert.equal((await req('POST', '/editions', { token: memberToken, body: { title: 'x', pdfUrl: 'y' } })).status, 403);
  assert.equal((await req('PATCH', '/editions/1', { token: memberToken, body: { title: 'x' } })).status, 403);
  assert.equal((await req('DELETE', '/editions/1', { token: memberToken })).status, 403);
  assert.equal((await req('GET', '/editions/admin/all')).status, 401);
});

// ----------------------------------------------------------------------- add

test('admin can add an edition, and the issue number is assigned automatically', async () => {
  const r = await add({ title: 'August 2026', publicationDate: '2026-08-01' });
  assert.equal(r.status, 201);
  assert.ok(r.body.edition.issue_number > 0, 'no issue number was assigned');
  assert.equal(Number(r.body.edition.download_price), 50, 'the R50 default did not apply');
});

test('an edition with no PDF is refused', async () => {
  const r = await req('POST', '/editions', { token: adminToken, body: { title: 'No File' } });
  assert.equal(r.status, 400);
});

// ------------------------------------------------------- publishing / privacy

test('only published editions are public; drafts stay admin-only', async () => {
  await add({ title: 'Secret Draft', status: 'draft', publicationDate: '2026-09-01' });

  const pub = await req('GET', '/editions');
  assert.ok(!pub.body.editions.some((e) => e.title === 'Secret Draft'), 'a draft edition is public');

  const adm = await req('GET', '/editions/admin/all', { token: adminToken });
  assert.ok(adm.body.editions.some((e) => e.title === 'Secret Draft'), 'the draft is missing from the admin list');
});

test('archived and unpublished editions drop off the site but are kept', async () => {
  const created = await add({ title: 'Pulled Edition', publicationDate: '2026-09-15' });
  const id = created.body.edition.id;

  await req('PATCH', `/editions/${id}`, { token: adminToken, body: { status: 'archived' } });
  const pub = await req('GET', '/editions');
  assert.ok(!pub.body.editions.some((e) => e.id === id), 'an archived edition is still public');

  const still = await pool.query('SELECT COUNT(*)::int AS n FROM editions WHERE id = $1', [id]);
  assert.equal(still.rows[0].n, 1, 'archiving deleted the edition');
});

// --------------------------------------------------------------------- latest

test('the homepage latest edition is the newest PUBLISHED one, by date', async () => {
  await add({ title: 'October 2026', publicationDate: '2026-10-01' });
  await add({ title: 'November 2026', publicationDate: '2026-11-01', status: 'draft' });

  const r = await req('GET', '/editions/latest');
  assert.equal(r.body.edition.title, 'October 2026',
    'the homepage picked an unpublished edition, or ordered by the wrong field');
});

test('publishing a newer edition changes the homepage with no code change', async () => {
  await add({ title: 'December 2026', publicationDate: '2026-12-01' });
  const r = await req('GET', '/editions/latest');
  assert.equal(r.body.edition.title, 'December 2026');
});

test('latest returns null rather than erroring when nothing is published', async () => {
  await pool.query(`UPDATE editions SET status = 'draft'`);
  const r = await req('GET', '/editions/latest');
  assert.equal(r.status, 200);
  assert.equal(r.body.edition, null, 'the homepage would break instead of hiding the panel');
  await pool.query(`UPDATE editions SET status = 'published' WHERE title = 'December 2026'`);
});

// ----------------------------------------------------------------------- edit

test('editing leaves the fields that were not sent alone', async () => {
  const created = await add({ title: 'Editable', description: 'Original text.', publicationDate: '2026-06-01' });
  const id = created.body.edition.id;

  await req('PATCH', `/editions/${id}`, { token: adminToken, body: { title: 'Renamed' } });

  const r = await pool.query('SELECT title, description, download_price FROM editions WHERE id = $1', [id]);
  assert.equal(r.rows[0].title, 'Renamed');
  assert.equal(r.rows[0].description, 'Original text.', 'an unrelated edit wiped the description');
  assert.equal(Number(r.rows[0].download_price), 50);
});

test('replacing the PDF keeps the edition and its purchases intact', async () => {
  const created = await add({ title: 'Reprint', publicationDate: '2026-04-01' });
  const id = created.body.edition.id;
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (77, 'buyer@test', 'x', 'member') ON CONFLICT DO NOTHING`);
  await pool.query('INSERT INTO edition_purchases (user_id, edition_id) VALUES (77, $1)', [id]);

  await req('PATCH', `/editions/${id}`, { token: adminToken, body: { pdfUrl: 'https://example.test/fixed.pdf' } });

  const r = await pool.query(
    `SELECT e.pdf_url, COUNT(ep.id)::int AS purchases
       FROM editions e LEFT JOIN edition_purchases ep ON ep.edition_id = e.id
      WHERE e.id = $1 GROUP BY e.pdf_url`, [id]
  );
  assert.equal(r.rows[0].pdf_url, 'https://example.test/fixed.pdf');
  assert.equal(r.rows[0].purchases, 1, 'replacing the PDF destroyed a purchase');
});

test('an invalid status is refused', async () => {
  const r = await req('PATCH', '/editions/1', { token: adminToken, body: { status: 'live' } });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------- delete

test('an edition nobody has bought can be deleted', async () => {
  const created = await add({ title: 'Mistake', publicationDate: '2026-03-01' });
  const r = await req('DELETE', `/editions/${created.body.edition.id}`, { token: adminToken });
  assert.equal(r.status, 200);
});

test('an edition someone has BOUGHT cannot be deleted', async () => {
  const bought = await pool.query(
    `SELECT edition_id FROM edition_purchases LIMIT 1`
  );
  const id = bought.rows[0].edition_id;
  const r = await req('DELETE', `/editions/${id}`, { token: adminToken });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Archived/, 'the refusal should say what to do instead');

  const still = await pool.query('SELECT COUNT(*)::int AS n FROM edition_purchases WHERE edition_id = $1', [id]);
  assert.equal(still.rows[0].n, 1, "the customer's purchase record was destroyed");
});
