'use strict';

// Ownership and response-shape coverage over real HTTP and PostgreSQL. This is
// intentionally separate from the fast mapping contract so repository CI can
// prove the member query without making source-only checks depend on Postgres.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let baseUrl;
let jwt;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-growth-member-status-'));
const port = 18400 + (process.pid % 300);

function tokenFor(userId) {
  return jwt.sign({ id: userId, email: `growth${userId}@test.com`, role: 'member' }, process.env.JWT_SECRET);
}

async function get(urlPath, token) {
  const response = await fetch(baseUrl + urlPath, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() };
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
  process.env.JWT_SECRET = 'test-secret-for-growth-member-status';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const migrations = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const migration of migrations) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', migration), 'utf8'));
  }

  jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/growth-application/v2', require('../src/routes/growthApplicationV2'));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (pg) await stopPostgres(pg, dataDir);
});

test('member list and detail expose friendly status only for the owning member', async () => {
  const ownerId = 91001;
  const otherId = 91002;
  await pool.query(
    `INSERT INTO users(id,email,password_hash,role) VALUES
       ($1,$2,'x','member'),($3,$4,'x','member')`,
    [ownerId, `growth${ownerId}@test.com`, otherId, `growth${otherId}@test.com`],
  );
  const owned = await pool.query(
    `INSERT INTO growth_applications
       (user_id,applicant_email,applicant_type,status,completion_percent,admin_notes,research_notes)
     VALUES($1,$2,'individual','information_requested',100,'private admin note','private research')
     RETURNING id`,
    [ownerId, `growth${ownerId}@test.com`],
  );
  const other = await pool.query(
    `INSERT INTO growth_applications
       (user_id,applicant_email,applicant_type,status,completion_percent)
     VALUES($1,$2,'business','submitted',100)
     RETURNING id`,
    [otherId, `growth${otherId}@test.com`],
  );
  const changedAt = '2026-09-20T08:15:00.000Z';
  await pool.query(
    `INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,created_at)
     VALUES($1,'under_review','information_requested',$2,$3)`,
    [owned.rows[0].id, ownerId, changedAt],
  );

  const ownerToken = tokenFor(ownerId);
  const list = await get('/growth-application/v2/applications', ownerToken);
  assert.equal(list.status, 200);
  assert.equal(list.body.applications.length, 1);
  assert.equal(list.body.applications[0].id, owned.rows[0].id);
  assert.deepEqual(list.body.applications[0].memberVisibleStatus, {
    key: 'action_required',
    label: 'Action required',
    description: 'Unplug needs more information from you. Open the request below to respond.',
    actionRequired: true,
    terminal: false,
    updatedAt: changedAt,
  });
  assert.equal(Object.hasOwn(list.body.applications[0], 'status_changed_at'), false);

  const detail = await get(`/growth-application/v2/applications/${owned.rows[0].id}`, ownerToken);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.application.memberVisibleStatus.label, 'Action required');
  assert.equal(Object.hasOwn(detail.body.application, 'admin_notes'), false);
  assert.equal(Object.hasOwn(detail.body.application, 'research_notes'), false);

  const crossMember = await get(`/growth-application/v2/applications/${other.rows[0].id}`, ownerToken);
  assert.equal(crossMember.status, 404);
});

test('Growth member status endpoints remain authenticated', async () => {
  const response = await get('/growth-application/v2/applications');
  assert.equal(response.status, 401);
});
