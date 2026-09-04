// A small batch from the punch-list's remaining Phase 6 items, checked
// against the real code rather than assumed:
//
// NAV-002 (CTA consistency): the article paywall gate's "Create a free
// account" button pointed at the dashboard's generic sign-in/sign-up choice
// screen, one click short of the welcome modal's own "Sign Up" button,
// which already carries ?signup=1 to skip straight to the sign-up form.
// Fixed to carry the same param and use the same "Sign Up" wording.
//
// PERF-002 (lazy loading): unplug-responsive-images.js already built
// UnplugImg.lazifyExisting() — a sweep adding loading="lazy" to any
// <img>/<iframe> without one — but nothing ever called it, so ~19 images
// across the site had no lazy attribute at all. Wired a debounced
// MutationObserver to call it after every batch of DOM changes, since this
// SPA inserts almost all of its content after page load via innerHTML.
//
// PERF-001 (CSP reports): GET /security/csp-reports already existed with
// nowhere to view it from. Added a read-only panel to the existing
// Redirects & 404s admin section.
//
// Website remediation punch-list (2026-09-03).
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

function readFile(filename) {
  const file = path.join(__dirname, '..', '..', filename);
  assert.ok(fs.existsSync(file), `${filename} should exist`);
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

// ------------------------------------------------------------- NAV-002

test('NAV-002: THE ARTICLE PAYWALL GATE\'S SIGN-UP LINK CARRIES signup=1, SAME AS THE WELCOME MODAL', () => {
  const src = readFile('unplug-magazine.html');
  const idx = src.indexOf('function articleGateHtml(a)');
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 1400);
  assert.match(body, /joinSignup = MEMBER_DASHBOARD_URL \+ '\?signup=1&next=' \+ back/);
  assert.match(body, /href="\$\{joinSignup\}">Sign Up</);
});

test('NAV-002: THE "ALREADY HAVE ONE" LINK DOES NOT CARRY signup=1 — IT SHOULD LAND ON THE GENERIC SIGN-IN CHOICE, NOT SKIP TO SIGN-UP', () => {
  const src = readFile('unplug-magazine.html');
  const idx = src.indexOf('function articleGateHtml(a)');
  const body = src.slice(idx, idx + 900);
  assert.match(body, /joinSignin = MEMBER_DASHBOARD_URL \+ '\?next=' \+ back/);
});

// ------------------------------------------------------------- PERF-002

test('PERF-002: A DEBOUNCED MutationObserver CALLS UnplugImg.lazifyExisting() ON EVERY DOM CHANGE BATCH', () => {
  const src = readFile('unplug-magazine.html');
  const idx = src.indexOf('function sweep()');
  assert.ok(idx > -1, 'the lazy-load sweep wiring must exist');
  const body = src.slice(idx, idx + 700);
  assert.match(body, /UnplugImg\.lazifyExisting\(\)/);
  assert.match(body, /new MutationObserver/);
  assert.match(body, /observer\.observe\(document\.body, \{ childList: true, subtree: true \}\)/);
});

test('PERF-002: THE SWEEP ALSO RUNS ONCE UP FRONT, NOT ONLY AFTER THE FIRST MUTATION', () => {
  const src = readFile('unplug-magazine.html');
  const idx = src.indexOf('function start()');
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 200);
  assert.match(body, /UnplugImg\.lazifyExisting\(\)/);
});

// ------------------------------------------------------------- PERF-001

test('PERF-001: THE ADMIN DASHBOARD RENDERS THE CSP REPORTS FROM THE REAL ENDPOINT, NOT A HARDCODED LIST', () => {
  const src = readFile('unplug-admin-dashboard.html');
  const idx = src.indexOf('async function loadCspReports()');
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 400);
  assert.match(body, /api\('\/security\/csp-reports'\)/);
});

test('PERF-001: LOADING THE REDIRECTS & 404s SECTION ALSO LOADS THE CSP REPORTS', () => {
  const src = readFile('unplug-admin-dashboard.html');
  const idx = src.indexOf('async function loadRedirects()');
  assert.ok(idx > -1);
  const fnEnd = src.indexOf('\n}', idx);
  const body = src.slice(idx, fnEnd);
  assert.match(body, /loadCspReports\(\)/);
});

// ---------------------------------------------------- PERF-001, live shape

let pg;
let pool;
let server;
let baseUrl;
let adminToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-navperf-'));
const port = 65200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}

async function req(method, urlPath, { token, body, contentType } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': contentType || 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body, e.g. the 204 */ }
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
  process.env.JWT_SECRET = 'test-secret-for-navperf';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }

  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES (992001, 'navperf-admin@test.com', 'x', 'admin')`);
  const jwt = require('jsonwebtoken');
  adminToken = jwt.sign({ id: 992001, email: 'navperf-admin@test.com', role: 'admin' }, process.env.JWT_SECRET);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(attachUser);
  app.use('/security', require('../src/routes/security'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('PERF-001: A REAL REPORTED VIOLATION SHOWS UP IN THE ADMIN LIST WITH THE FIELDS THE UI RENDERS', async () => {
  await req('POST', '/security/csp-report', {
    body: { 'csp-report': { 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example/x.js', 'document-uri': 'https://unplugnews.com/?p=news' } },
    contentType: 'application/csp-report',
  });
  const { status, body } = await req('GET', '/security/csp-reports', { token: adminToken });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.reports));
  const row = body.reports.find((r) => r.directive === 'script-src-elem');
  assert.ok(row, 'the reported violation should appear in the admin list');
  assert.equal(row.blocked_uri, 'https://evil.example/x.js');
  assert.equal(row.document_uri, 'https://unplugnews.com/', 'the query string must be stripped so repeat visits do not fragment the count');
  assert.ok(typeof body.note === 'string' && body.note.length > 0, 'the admin view must explain this is report-only data, not something already blocked');
});

test('PERF-001: A NON-ADMIN CANNOT READ THE CSP REPORTS', async () => {
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES (992002, 'navperf-member@test.com', 'x', 'member')`);
  const jwt = require('jsonwebtoken');
  const memberToken = jwt.sign({ id: 992002, email: 'navperf-member@test.com', role: 'member' }, process.env.JWT_SECRET);
  assert.equal((await req('GET', '/security/csp-reports', { token: memberToken })).status, 403);
  assert.equal((await req('GET', '/security/csp-reports')).status, 401);
});
