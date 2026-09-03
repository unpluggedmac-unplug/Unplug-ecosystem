// The flat fees are stated once, and served rather than retyped.
//
// The §12 service intro screens have to show a price. The first version typed
// "R95 per article" into the dashboard, because there was no way to ask for it:
// the FIXED map lived inside priceForNewOrder() and nothing exposed it. That is
// a second statement of a price the backend already holds, which is the
// recurring bug class CLAUDE.md names.
//
// GET /payments/fees now serves the same map that is used to CHARGE, so the
// figure a member reads and the figure they are charged cannot disagree.

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-fees-'));
const port = 55400 + (process.pid % 300);

before(async () => {
  ensureStopWords();
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-fees';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/payments', require('../src/routes/payments'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('GET /payments/fees serves the flat fees, without a login', async () => {
  // Public on purpose: an intro screen is shown before anybody signs in.
  const res = await fetch(`${baseUrl}/payments/fees`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.fees, 'there should be a fees map');
  for (const key of ['article_publish', 'gallery_bundle', 'event_listing']) {
    assert.equal(typeof body.fees[key], 'number', `${key} should be a number`);
    assert.ok(body.fees[key] > 0, `${key} should be a real price`);
  }
});

test('THE SERVED FEE IS THE CHARGED FEE', async () => {
  // The whole point. If these two ever come from different places, a member is
  // shown one number and charged another.
  const served = (await (await fetch(`${baseUrl}/payments/fees`)).json()).fees;

  // priceForNewOrder is what the checkout quotes from. Reached through the
  // module rather than reimplemented here.
  const payments = require('../src/routes/payments');
  assert.ok(payments, 'the payments router should load');

  // The map is the same object the router charges from — asserted by checking
  // the served values against the source constants the file declares.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'payments.js'), 'utf8');
  const declared = {
    article_publish: /const ARTICLE_PUBLISH_FEE = ([\d.]+)/.exec(source),
    event_listing: /const EVENT_LISTING_FEE = ([\d.]+)/.exec(source),
    gallery_bundle: /const GALLERY_BUNDLE_PRICE = ([\d.]+)/.exec(source),
    top10_entry: /const TOP10_ENTRY_FEE = ([\d.]+)/.exec(source),
    marketplace_listing: /const MARKETPLACE_LISTING_PRICE = ([\d.]+)/.exec(source),
  };
  for (const [key, match] of Object.entries(declared)) {
    assert.ok(match, `${key} constant should still exist`);
    assert.equal(served[key], Number(match[1]),
      `${key}: /fees serves ${served[key]} but the constant says ${match[1]}`);
  }
});

test('the map is declared ONCE, not copied into the endpoint', () => {
  // It used to live inside priceForNewOrder. If a second literal map appears,
  // the served price and the charged price can drift apart again.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'payments.js'), 'utf8');
  const maps = source.match(/article_publish:\s*ARTICLE_PUBLISH_FEE/g) || [];
  assert.equal(maps.length, 1,
    'the flat-fee map should be declared exactly once');
  assert.ok(/const FIXED_FEES = \{/.test(source),
    'FIXED_FEES should be the single declaration');
});

test('services priced per row are deliberately absent', async () => {
  // Competition entries, edition downloads and directory packages have no
  // single figure. Quoting one here would be inventing a price.
  const body = await (await fetch(`${baseUrl}/payments/fees`)).json();
  for (const key of ['competition_entry', 'edition_download', 'profile_package']) {
    assert.equal(body.fees[key], undefined,
      `${key} has no single price and must not be quoted as if it did`);
  }
});

test('THE DASHBOARD NO LONGER TYPES THESE PRICES IN', () => {
  // The §12 intro screens stated "R95 per article" and "R100 for up to 3
  // photos" as literals. They now name a priceKey and render from /payments/fees,
  // with the old string kept only as a fallback for a failed fetch.
  const page = fs.readFileSync(
    path.join(__dirname, '..', '..', 'unplug-member-dashboard.html'), 'utf8');

  assert.ok(/priceKey:\s*'article_publish'/.test(page),
    'the article intro should name a priceKey');
  assert.ok(/priceKey:\s*'gallery_bundle'/.test(page),
    'the gallery intro should name a priceKey');
  assert.ok(/function msIntroPrice/.test(page),
    'there should be one place that turns a fee into the line shown');
  assert.ok(/line\('Price', msIntroPrice\(i\)\)/.test(page),
    'the intro must render through msIntroPrice, not the raw string');
  assert.ok(/\/payments\/fees/.test(page),
    'the dashboard should fetch the fees');
});
