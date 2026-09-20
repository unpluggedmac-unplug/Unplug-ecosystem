// Batch D — Directory pricing + fail-closed money path.
//
// Real PostgreSQL is intentional here. These are money guarantees:
//   * the migration starts at the exact six prices already charged;
//   * admin edits become the public quote AND the amount resolveAmount uses;
//   * migration re-runs never reset an admin edit;
//   * switching off a tier makes only that tier unavailable;
//   * an unreadable pricing table creates NO payment and NO cart order.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const { ensureStopWords } = require('./helpers/textSearch');

let pg;
let pool;
let server;
let baseUrl;
let jwt;
let memberToken;
let adminToken;
let profileId;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-batch-d-pricing-'));
const port = 61900 + (process.pid % 300);
const MEMBER = 991301;
const ADMIN = 991302;

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

async function runAllMigrations() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const file of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
}

async function rerun214() {
  const file = path.join(__dirname, '..', 'db', 'migrations', '214_directory_package_pricing.sql');
  await pool.query(fs.readFileSync(file, 'utf8'));
}

before(async () => {
  ensureStopWords();
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = \`postgres://postgres:postgres@localhost:\${port}/unplug_test\`;
  process.env.JWT_SECRET = 'batch-d-pricing-secret';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runAllMigrations();

  await pool.query(
    \`INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES ($1,'batchd-member@test.com','Batch D Member','x','member'),
            ($2,'batchd-admin@test.com','Batch D Admin','x','admin')\`,
    [MEMBER, ADMIN]
  );
  const p = await pool.query(
    \`INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1,'business','pro','batch-d-business','Batch D Business','awaiting_payment')
     RETURNING id\`,
    [MEMBER]
  );
  profileId = p.rows[0].id;

  jwt = require('jsonwebtoken');
  memberToken = jwt.sign({ id: MEMBER, email: 'batchd-member@test.com', role: 'member' }, process.env.JWT_SECRET);
  adminToken = jwt.sign({ id: ADMIN, email: 'batchd-admin@test.com', role: 'admin' }, process.env.JWT_SECRET);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(attachUser);
  app.use('/payments', require('../src/routes/payments'));
  app.use('/orders', require('../src/routes/orders'));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = \`http://127.0.0.1:\${server.address().port}\`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('migration 214 seeds the exact six prices already charged before Batch D', async () => {
  const r = await pool.query(
    \`SELECT profile_type, tier, price
       FROM directory_package_prices
      ORDER BY profile_type, tier\`
  );
  assert.equal(r.rowCount, 6);
  const got = Object.fromEntries(r.rows.map((x) => [
    \`\${x.profile_type}:\${x.tier}\`, Number(x.price),
  ]));
  assert.deepEqual(got, {
    'business:basic': 500,
    'business:premium': 1000,
    'business:pro': 700,
    'individual:basic': 150,
    'individual:premium': 400,
    'individual:pro': 280,
  });
});

test('public Directory pricing is sourced from those active rows', async () => {
  const r = await req('GET', '/payments/directory-packages');
  assert.equal(r.status, 200);
  assert.equal(r.body.priceMap.business.pro, 700);
  assert.equal(r.body.priceMap.individual.basic, 150);
  assert.equal(r.body.packages.length, 6);
});

test('an Admin price edit becomes both the public price and the server quote', async () => {
  const row = await pool.query(
    \`SELECT id FROM directory_package_prices
      WHERE profile_type='business' AND tier='pro'\`
  );
  const id = row.rows[0].id;

  const saved = await req('PATCH', \`/payments/admin/directory-packages/\${id}\`, {
    token: adminToken,
    body: { price: 777 },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.package.price, 777);

  const publicPricing = await req('GET', '/payments/directory-packages');
  assert.equal(publicPricing.status, 200);
  assert.equal(publicPricing.body.priceMap.business.pro, 777);

  const quote = await req('POST', '/payments/quote', {
    token: memberToken,
    body: { linkedType: 'profile_package', linkedId: profileId, useCredit: false },
  });
  assert.equal(quote.status, 200);
  assert.equal(quote.body.orderTotal, 777);
  assert.equal(quote.body.amountToPay, 777);
});

test('re-running migration 214 never resets an Admin price edit', async () => {
  await rerun214();
  const r = await pool.query(
    \`SELECT price FROM directory_package_prices
      WHERE profile_type='business' AND tier='pro'\`
  );
  assert.equal(Number(r.rows[0].price), 777,
    'ON CONFLICT must leave the admin-set price untouched');
});

test('switching off one tier hides and refuses only that tier', async () => {
  const row = await pool.query(
    \`SELECT id FROM directory_package_prices
      WHERE profile_type='business' AND tier='pro'\`
  );
  const id = row.rows[0].id;

  const off = await req('PATCH', \`/payments/admin/directory-packages/\${id}\`, {
    token: adminToken,
    body: { active: false },
  });
  assert.equal(off.status, 200);

  const publicPricing = await req('GET', '/payments/directory-packages');
  assert.equal(publicPricing.status, 200);
  assert.equal(publicPricing.body.priceMap.business.pro, undefined);
  assert.equal(publicPricing.body.priceMap.business.basic, 500,
    'other tiers remain available');

  const quote = await req('POST', '/payments/quote', {
    token: memberToken,
    body: { linkedType: 'profile_package', linkedId: profileId, useCredit: false },
  });
  assert.equal(quote.status, 400);
  assert.match(quote.body.error, /not currently available/i);

  await req('PATCH', \`/payments/admin/directory-packages/\${id}\`, {
    token: adminToken,
    body: { active: true },
  });
});

test('A PRICING OUTAGE CREATES NO PAYMENT AND NO CART ORDER', async () => {
  const beforePayments = await pool.query('SELECT COUNT(*)::int AS n FROM payments');
  const beforeOrders = await pool.query('SELECT COUNT(*)::int AS n FROM orders');

  await pool.query(
    'ALTER TABLE directory_package_prices RENAME TO directory_package_prices_batch_d_outage'
  );
  try {
    const publicPricing = await req('GET', '/payments/directory-packages');
    assert.equal(publicPricing.status, 503);
    assert.match(publicPricing.body.error, /temporarily unavailable/i);

    const quote = await req('POST', '/payments/quote', {
      token: memberToken,
      body: { linkedType: 'profile_package', linkedId: profileId, useCredit: false },
    });
    assert.equal(quote.status, 503);
    assert.match(quote.body.error, /No order was created/i);

    const initiate = await req('POST', '/payments/initiate', {
      token: memberToken,
      body: {
        linkedType: 'profile_package',
        linkedId: profileId,
        method: 'eft',
        termsAccepted: true,
        useCredit: false,
      },
    });
    assert.equal(initiate.status, 503);
    assert.match(initiate.body.error, /No payment was created/i);

    const cart = await req('POST', '/orders/initiate', {
      token: memberToken,
      body: {
        items: [{ linkedType: 'profile_package', linkedId: profileId }],
        method: 'eft',
        termsAccepted: true,
        infoConfirmed: true,
        useCredit: false,
      },
    });
    assert.equal(cart.status, 503);
    assert.match(cart.body.error, /No order was created/i);

    const afterPayments = await pool.query('SELECT COUNT(*)::int AS n FROM payments');
    const afterOrders = await pool.query('SELECT COUNT(*)::int AS n FROM orders');
    assert.equal(afterPayments.rows[0].n, beforePayments.rows[0].n,
      'pricing failure must not create a payment row');
    assert.equal(afterOrders.rows[0].n, beforeOrders.rows[0].n,
      'pricing failure must not create an order row');
  } finally {
    await pool.query(
      'ALTER TABLE directory_package_prices_batch_d_outage RENAME TO directory_package_prices'
    );
  }
});
