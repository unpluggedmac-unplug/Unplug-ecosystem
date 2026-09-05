// The full real path for the per-consultant free-publishing toggle:
// database → a REAL sign-in through POST /auth/login → the JWT that comes
// back → consumed by POST /articles. Everything else (the admin PATCH route,
// and publishesFree()/statusForNewSubmission() themselves) already has its
// own test file (usersAdmin.test.js, freePublishing.test.js) — this one
// exists because those two prove the ends of the chain but not that
// auth.js's login route actually EMBEDS the claim in a real token, which is
// the one link a hand-signed test token can't verify.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-consultlogin-'));
const port = 58000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
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
  process.env.JWT_SECRET = 'test-secret-for-consultant-login';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const passwordHash = await bcrypt.hash('correct-horse-battery-staple', 10);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, email_verified, free_publishing_enabled)
     VALUES (901, 'toggled-off@unplugnews.com', $1, 'consultant', true, false),
            (902, 'default-on@unplugnews.com', $1, 'consultant', true, true)
     ON CONFLICT DO NOTHING`,
    [passwordHash]
  );

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/auth', require('../src/routes/auth'));
  app.use('/articles', require('../src/routes/articles'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('A REAL LOGIN FOR A CONSULTANT WITH THE TOGGLE OFF ISSUES A TOKEN CARRYING THAT, AND IT IS HONOURED END-TO-END', async () => {
  const login = await req('POST', '/auth/login', {
    body: { email: 'toggled-off@unplugnews.com', password: 'correct-horse-battery-staple' },
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.token, 'a real session must be issued');

  const claims = jwt.decode(login.body.token);
  assert.equal(claims.free_publishing_enabled, false, 'the real login route must embed the live column value, not omit it');

  const submit = await req('POST', '/articles', {
    token: login.body.token,
    body: { title: 'Billed Like A Member', body: 'The toggle was off at the moment this article was created.', bodyFormat: 'text' },
  });
  assert.equal(submit.status, 201);
  assert.equal(submit.body.article.status, 'awaiting_payment', 'a real end-to-end login must actually be billed, not just the claim being present');
});

test('A REAL LOGIN FOR A CONSULTANT WITH THE TOGGLE ON (THE DEFAULT) PUBLISHES FREE, END-TO-END', async () => {
  const login = await req('POST', '/auth/login', {
    body: { email: 'default-on@unplugnews.com', password: 'correct-horse-battery-staple' },
  });
  assert.equal(login.status, 200);

  const claims = jwt.decode(login.body.token);
  assert.equal(claims.free_publishing_enabled, true);

  const submit = await req('POST', '/articles', {
    token: login.body.token,
    body: { title: 'Still Free', body: 'The toggle stayed on for this real login.', bodyFormat: 'text' },
  });
  assert.equal(submit.status, 201);
  assert.equal(submit.body.article.status, 'pending');
});
