// Regression guard for the 2026-09-28 removal:
// removed bulk-voting entry points must stay gone while normal voting still works.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const { ensureStopWords } = require('./helpers/textSearch');

let pg, pool, server, baseUrl, entryId;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-no-bulk-vote-'));
const port = 53900 + (process.pid % 300);

async function req(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  ensureStopWords();
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise(); await pg.start(); await pg.createDatabase('unplug_test');
  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-no-bulk';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  const owner = 991001;
  await pool.query(`INSERT INTO users (id,email,password_hash,role) VALUES ($1,'owner@nobulk.test','x','member')`, [owner]);
  const profile = await pool.query(`INSERT INTO profiles (user_id,type,package_tier,slug,display_name,status)
    VALUES ($1,'individual','basic','no-bulk-target','Normal Vote Target','approved') RETURNING id`, [owner]);
  const comp = await pool.query(`SELECT id FROM competitions WHERE slug='top-10'`);
  const entry = await pool.query(`INSERT INTO competition_entries (competition_id,profile_id,status)
    VALUES ($1,$2,'approved') RETURNING id`, [comp.rows[0].id, profile.rows[0].id]);
  entryId = entry.rows[0].id;

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/', require('../src/routes/competitions'));
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('removed public bulk-voting API routes return real 404 responses', async () => {
  assert.equal((await req('GET', '/vote-bundle-tiers')).status, 404);
  assert.equal((await req('POST', `/entries/${entryId}/vote-bundle`, { votes: 50, sessionId: 'x' })).status, 404);
  assert.equal((await req('GET', '/vote-bundles/status/LEGACY')).status, 404);
  assert.equal((await req('PATCH', '/vote-bundles/LEGACY/proof', { url: 'https://example.test/proof' })).status, 404);
});

test('removed admin bulk-voting API routes return real 404 responses', async () => {
  assert.equal((await req('GET', '/admin/vote-bundles')).status, 404);
  assert.equal((await req('PATCH', '/admin/vote-bundles/1/approve')).status, 404);
  assert.equal((await req('PATCH', '/admin/vote-bundles/1/reject')).status, 404);
  assert.equal((await req('POST', '/admin/vote-bundles/1/reverse')).status, 404);
});

test('normal individual voting remains operational', async () => {
  const vote = await req('POST', `/entries/${entryId}/vote`, { sessionId: 'normal-voter-1' });
  assert.equal(vote.status, 201, JSON.stringify(vote.body));
  const stored = await pool.query(`SELECT COUNT(*)::int AS rows, COALESCE(SUM(bundle_size),0)::int AS votes
    FROM votes WHERE entry_id=$1`, [entryId]);
  assert.equal(stored.rows[0].rows, 1);
  assert.equal(stored.rows[0].votes, 1);
});

test('bulk portal is absent from packaged source and checkout has no bulk mode', () => {
  const root = path.join(__dirname, '..', '..');
  assert.equal(fs.existsSync(path.join(root, 'unplug-vote.html')), false);
  const checkout = fs.readFileSync(path.join(root, 'unplug-checkout.html'), 'utf8');
  assert.doesNotMatch(checkout, /vote_bundle|vote-bundle|bulk votes?/i);
});
