// One price, in one place.
//
// Batch D decision 2A: an unreadable pricing table must STOP a purchase, not
// charge a hardcoded "last known" number. These tests protect that choice.
//
// Duration-based Highlight/Banner pricing lives only in service_packages.
// Directory package pricing has its own matrix table and is tested separately.

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
let servicePackages;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-pricing-'));
const port = 55000 + (process.pid % 300);

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

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const file of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }

  servicePackages = require('../src/utils/servicePackages');
}, { timeout: 120000 });

after(async () => {
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('THERE IS NO HARDCODED DURATION-PRICE FALLBACK', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'utils', 'servicePackages.js'), 'utf8');
  assert.doesNotMatch(source, /\bFALLBACK_PRICES\b/,
    'a hardcoded fallback can charge a stale price after an admin edit');
  assert.doesNotMatch(source, /\{\s*7\s*:\s*\d/,
    'servicePackages.js must not carry a second duration-price ladder');
});

test('the dead payment-route price copies stay gone', () => {
  const payments = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'payments.js'), 'utf8');
  assert.doesNotMatch(payments, /const\s+HIGHLIGHT_PRICES\s*=/);
  assert.doesNotMatch(payments, /const\s+AD_BANNER_PRICES\s*=/);
  assert.doesNotMatch(payments, /const\s+PACKAGE_PRICES\s*=/,
    'Directory pricing now belongs in directory_package_prices, not payments.js');
});

test('priceFor reads the admin-managed table value', async () => {
  await pool.query(
    `UPDATE service_packages SET price = 12345.00
      WHERE service_key = 'ad_banner' AND duration_days = 7`);
  assert.equal(await servicePackages.priceFor('ad_banner', 7), 12345);
});

test('an inactive or unknown package has no hidden price', async () => {
  await pool.query(
    `UPDATE service_packages SET active = false
      WHERE service_key = 'highlight_article' AND duration_days = 21`);
  assert.equal(await servicePackages.priceFor('highlight_article', 21), null);
  assert.equal(await servicePackages.priceFor('ad_banner', 999), null);
  assert.equal(await servicePackages.priceFor('not_a_service', 7), null);
});

test('AN UNREADABLE PRICING TABLE FAILS CLOSED', async () => {
  await pool.query('ALTER TABLE service_packages RENAME TO service_packages_batch_d_outage');
  try {
    await assert.rejects(
      () => servicePackages.priceFor('ad_banner', 7),
      (err) => err && err.code === 'PRICING_UNAVAILABLE' && err.statusCode === 503
    );
    await assert.rejects(
      () => servicePackages.packagesFor('highlight_article'),
      (err) => err && err.code === 'PRICING_UNAVAILABLE' && err.statusCode === 503
    );
  } finally {
    await pool.query('ALTER TABLE service_packages_batch_d_outage RENAME TO service_packages');
  }
});

test('THE BANNER PRICE SENTENCE HAS ONE LIVE LOADER, NOT TEN PRICE TABLES', () => {
  const page = fs.readFileSync(
    path.join(__dirname, '..', '..', 'unplug-magazine.html'), 'utf8');

  const tagged = (page.match(/<p class="js-banner-pricing">/g) || []).length;
  assert.ok(tagged >= 10, `expected every banner sentence tagged, found ${tagged}`);

  const loaders = (page.match(/payments\/packages\?service=ad_banner/g) || []).length;
  assert.equal(loaders, 1, 'there should be exactly one live banner-pricing loader');
  assert.ok(/js-banner-pricing[\s\S]{0,4000}textContent/.test(page),
    'network price data must be written with textContent');
});

test('THE PUBLIC DEMO PAGE STATES NO PRICE', () => {
  const demo = fs.readFileSync(
    path.join(__dirname, '..', '..', 'unplug-components-demo.html'), 'utf8');
  const visible = demo.replace(/<!--[\s\S]*?-->/g, '');
  const prices = visible.match(/R\s?\d[\d,]*/g) || [];
  assert.deepEqual(prices, []);
});
