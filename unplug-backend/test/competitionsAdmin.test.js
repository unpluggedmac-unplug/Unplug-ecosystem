// Admin competition management, driven over real HTTP against the real Express
// app and a real PostgreSQL.
//
// The delete rules are the reason this is an end-to-end test rather than a unit
// test. competition_entries and votes CASCADE from competitions, and both carry
// payment_id — so a delete that slips through the guard destroys entries and
// votes that people paid for, and leaves the payment rows pointing at nothing.
// That is not recoverable, so the guards are tested through the actual route
// stack, including the admin role check.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-comptest-'));
const port = 6410 + (process.pid % 300);

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
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

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-competitions-admin';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }

  const jwt = require('jsonwebtoken');
  adminToken = jwt.sign({ id: 1, email: 'admin@test', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 2, email: 'member@test', role: 'member' }, process.env.JWT_SECRET);

  // Mount the REAL competitions router and the REAL auth middleware on a bare
  // Express app. src/app.js can't be required here: it calls app.listen() and
  // starts a birthday-email setInterval at module load, which would hold the
  // test process open forever. This still exercises the actual routes and the
  // actual requireRole gate — only the unrelated app wiring is left out.
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/', require('../src/routes/competitions'));
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

// ---------------------------------------------------------------- permissions

test('a member cannot list, edit or delete competitions', async () => {
  const list = await req('GET', '/competitions/admin/all', { token: memberToken });
  assert.equal(list.status, 403);
  const edit = await req('PATCH', '/competitions/1', { token: memberToken, body: { name: 'Hijacked' } });
  assert.equal(edit.status, 403);
  const del = await req('DELETE', '/competitions/1', { token: memberToken });
  assert.equal(del.status, 403);
});

test('a signed-out visitor cannot reach the admin routes', async () => {
  assert.equal((await req('GET', '/competitions/admin/all')).status, 401);
  assert.equal((await req('DELETE', '/competitions/1')).status, 401);
});

// ----------------------------------------------------------------------- list

test('the admin list includes every status, not just open ones', async () => {
  await req('POST', '/competitions', {
    token: adminToken,
    body: { name: 'Hidden Draft', slug: 'hidden-draft', opensAt: '2026-01-01', closesAt: '2026-12-01', status: 'draft' },
  });
  const pub = await req('GET', '/competitions');
  const adm = await req('GET', '/competitions/admin/all', { token: adminToken });
  assert.ok(!pub.body.competitions.some((c) => c.slug === 'hidden-draft'), 'a draft leaked to the public list');
  assert.ok(adm.body.competitions.some((c) => c.slug === 'hidden-draft'), 'the draft is missing from the admin list');
});

test('built-in competitions are flagged so the UI can protect them', async () => {
  const { body } = await req('GET', '/competitions/admin/all', { token: adminToken });
  const arena = body.competitions.find((c) => c.slug === 'the-arena');
  const draft = body.competitions.find((c) => c.slug === 'hidden-draft');
  assert.equal(arena.builtIn, true);
  assert.equal(draft.builtIn, false);
});

// ----------------------------------------------------------------------- edit

test('admin can change the name, dates, fee and status', async () => {
  const { body } = await req('GET', '/competitions/admin/all', { token: adminToken });
  const id = body.competitions.find((c) => c.slug === 'hidden-draft').id;

  const r = await req('PATCH', `/competitions/${id}`, {
    token: adminToken,
    body: {
      name: 'Renamed Competition',
      description: 'Now with a description.',
      closesAt: '2027-02-28T21:59:59Z',
      entryFee: 175,
      status: 'open',
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.competition.name, 'Renamed Competition');
  assert.equal(Number(r.body.competition.entry_fee), 175);
  assert.equal(r.body.competition.status, 'open');
});

test('omitted fields are left alone rather than blanked', async () => {
  const { body } = await req('GET', '/competitions/admin/all', { token: adminToken });
  const comp = body.competitions.find((c) => c.slug === 'hidden-draft');

  await req('PATCH', `/competitions/${comp.id}`, { token: adminToken, body: { name: 'Just The Name' } });

  const after = (await req('GET', '/competitions/admin/all', { token: adminToken }))
    .body.competitions.find((c) => c.slug === 'hidden-draft');
  assert.equal(after.name, 'Just The Name');
  assert.equal(after.description, 'Now with a description.', 'description was wiped by an unrelated edit');
  assert.equal(Number(after.entry_fee), 175, 'entry fee was wiped by an unrelated edit');
});

test('the slug cannot be changed — page code looks competitions up by it', async () => {
  const { body } = await req('GET', '/competitions/admin/all', { token: adminToken });
  const id = body.competitions.find((c) => c.slug === 'the-arena').id;
  const r = await req('PATCH', `/competitions/${id}`, { token: adminToken, body: { slug: 'the-colosseum' } });
  assert.equal(r.status, 400);

  const still = await req('GET', '/competitions/the-arena');
  assert.equal(still.status, 200, 'the Competitions page can no longer load The Arena');
});

test('a closing date before the opening date is rejected and nothing is saved', async () => {
  const before = (await req('GET', '/competitions/admin/all', { token: adminToken }))
    .body.competitions.find((c) => c.slug === 'hidden-draft');

  const r = await req('PATCH', `/competitions/${before.id}`, {
    token: adminToken,
    body: { opensAt: '2027-06-01', closesAt: '2027-01-01' },
  });
  assert.equal(r.status, 400);

  const after = (await req('GET', '/competitions/admin/all', { token: adminToken }))
    .body.competitions.find((c) => c.slug === 'hidden-draft');
  assert.equal(
    new Date(after.opens_at).toISOString(), new Date(before.opens_at).toISOString(),
    'a rejected edit still changed the dates'
  );
});

test('a negative entry fee is rejected', async () => {
  const { body } = await req('GET', '/competitions/admin/all', { token: adminToken });
  const id = body.competitions.find((c) => c.slug === 'hidden-draft').id;
  const r = await req('PATCH', `/competitions/${id}`, { token: adminToken, body: { entryFee: -50 } });
  assert.equal(r.status, 400);
});

// ------------------------------------------------------------------------ add

test('admin can add a competition, and duplicate web addresses are refused', async () => {
  const ok = await req('POST', '/competitions', {
    token: adminToken,
    body: { name: 'Spring Awards', slug: 'spring-awards', opensAt: '2026-09-01', closesAt: '2026-11-30', entryFee: 80 },
  });
  assert.equal(ok.status, 201);

  const dupe = await req('POST', '/competitions', {
    token: adminToken,
    body: { name: 'Another', slug: 'spring-awards', opensAt: '2026-09-01', closesAt: '2026-11-30' },
  });
  assert.equal(dupe.status, 409);
});

test('a malformed web address is refused', async () => {
  const r = await req('POST', '/competitions', {
    token: adminToken,
    body: { name: 'Bad Slug', slug: 'Not A Slug!', opensAt: '2026-09-01', closesAt: '2026-11-30' },
  });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------- delete

test('an unused competition can be deleted', async () => {
  const { body } = await req('GET', '/competitions/admin/all', { token: adminToken });
  const id = body.competitions.find((c) => c.slug === 'spring-awards').id;
  assert.equal((await req('DELETE', `/competitions/${id}`, { token: adminToken })).status, 200);

  const after = await req('GET', '/competitions/admin/all', { token: adminToken });
  assert.ok(!after.body.competitions.some((c) => c.slug === 'spring-awards'));
});

test('a competition with paid entries CANNOT be deleted', async () => {
  // The scenario that must never succeed: someone paid to enter, and deleting
  // the competition would cascade their entry and votes away.
  const { rows } = await pool.query(`SELECT id FROM competitions WHERE slug = 'hidden-draft'`);
  const compId = rows[0].id;
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (99, 'entrant@test', 'x', 'member') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO profiles (id, user_id, display_name, slug, package_tier)
                    VALUES (99, 99, 'Entrant', 'entrant', 'basic') ON CONFLICT DO NOTHING`);
  await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, entry_fee, status)
     VALUES ($1, 99, 175.00, 'approved')`, [compId]
  );

  const r = await req('DELETE', `/competitions/${compId}`, { token: adminToken });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Closed/, 'the refusal should tell the admin what to do instead');

  const still = await pool.query('SELECT COUNT(*)::int AS n FROM competition_entries WHERE competition_id = $1', [compId]);
  assert.equal(still.rows[0].n, 1, 'the paid entry was destroyed');
});

test('built-in competitions cannot be deleted even with no entries', async () => {
  const { rows } = await pool.query(`SELECT id FROM competitions WHERE slug = 'top-10'`);
  const r = await req('DELETE', `/competitions/${rows[0].id}`, { token: adminToken });
  assert.equal(r.status, 400);

  const still = await pool.query(`SELECT COUNT(*)::int AS n FROM competitions WHERE slug = 'top-10'`);
  assert.equal(still.rows[0].n, 1, 'the Top 10 page just lost its competition');
});

test('closing a competition hides it from the public but keeps its entries', async () => {
  // The alternative the delete guard points admins at — it has to actually work.
  const { rows } = await pool.query(`SELECT id FROM competitions WHERE slug = 'hidden-draft'`);
  await req('PATCH', `/competitions/${rows[0].id}`, { token: adminToken, body: { status: 'closed' } });

  const pub = await req('GET', '/competitions');
  assert.ok(!pub.body.competitions.some((c) => c.slug === 'hidden-draft'), 'a closed competition is still public');

  const entries = await pool.query('SELECT COUNT(*)::int AS n FROM competition_entries WHERE competition_id = $1', [rows[0].id]);
  assert.equal(entries.rows[0].n, 1, 'closing destroyed the entries');
});
