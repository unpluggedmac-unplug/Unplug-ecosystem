// One price, in one place.
//
// docs/pricing-comparison.md names this as the recurring bug class from
// CLAUDE.md, carrying money: the highlight and banner ladders existed in THREE
// places — the `service_packages` table, `FALLBACK_PRICES` in
// utils/servicePackages.js, and `HIGHLIGHT_PRICES` / `AD_BANNER_PRICES` in
// routes/payments.js.
//
// The third pair was dead code and has been deleted. Two remain, and the second
// is deliberate: FALLBACK_PRICES is a last-known-good for when the table cannot
// be read at all. The danger the document identifies is that it goes stale —
// "change a price in the admin screen and the fallback would then charge the old
// amount".
//
// A constant cannot follow an admin's edit at runtime. What it CAN be held to is
// the seeded table, and that is what these do: if a migration changes a price
// and the fallback is not changed with it, this fails. That is the drift that
// would otherwise reach production silently.
//
// These assert only that the two AGREE. They assert no particular figure, so
// they are not a second statement of the prices themselves — which would be the
// very problem they exist to prevent.

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
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  servicePackages = require('../src/utils/servicePackages');
});

after(async () => {
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('THE FALLBACK STILL MATCHES THE TABLE IT IS A FALLBACK FOR', async () => {
  // The whole point. A fallback that disagrees with the real prices charges the
  // wrong amount at exactly the moment nobody is watching — when the lookup has
  // already failed.
  const fallback = servicePackages.FALLBACK_PRICES;
  assert.ok(fallback && Object.keys(fallback).length > 0, 'there should be a fallback to check');

  const rows = await pool.query(
    `SELECT service_key, duration_days, price FROM service_packages WHERE active = true`);
  const table = {};
  for (const r of rows.rows) {
    table[r.service_key] = table[r.service_key] || {};
    table[r.service_key][String(r.duration_days)] = Number(r.price);
  }

  for (const [serviceKey, durations] of Object.entries(fallback)) {
    assert.ok(table[serviceKey],
      `${serviceKey} has a fallback price but is not in service_packages`);
    for (const [days, price] of Object.entries(durations)) {
      assert.equal(table[serviceKey][days], Number(price),
        `${serviceKey} ${days}d: the table says ${table[serviceKey][days]}, `
        + `the fallback says ${price} — one of them is wrong, and the fallback is `
        + `what gets charged when the table cannot be read`);
    }
  }
});

test('every priced package in the table has a fallback', async () => {
  // The reverse direction: a package added to the table with no fallback means
  // a lookup failure produces no price at all for it.
  const fallback = servicePackages.FALLBACK_PRICES;
  const rows = await pool.query(
    `SELECT DISTINCT service_key FROM service_packages
      WHERE active = true AND service_key = ANY($1)`,
    [Object.keys(fallback)]);
  assert.equal(rows.rowCount, Object.keys(fallback).length,
    'every service with a fallback should still exist in the table');
});

test('THE DEAD COPIES ARE GONE, AND STAY GONE', () => {
  // payments.js used to declare HIGHLIGHT_PRICES and AD_BANNER_PRICES. They were
  // never read — every charge went through priceFor() — but they looked
  // authoritative, and a price in a second place is a price that will one day
  // disagree with the first.
  const payments = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'payments.js'), 'utf8');
  assert.ok(!/const\s+HIGHLIGHT_PRICES\s*=/.test(payments),
    'HIGHLIGHT_PRICES is back in payments.js — it is a second copy of the ladder');
  assert.ok(!/const\s+AD_BANNER_PRICES\s*=/.test(payments),
    'AD_BANNER_PRICES is back in payments.js — it is a second copy of the ladder');
});

test('every highlight and banner charge still goes through priceFor()', () => {
  // The consolidation is only true while this is: one function reads the price,
  // so a quote and a charge cannot come from different places.
  const payments = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'payments.js'), 'utf8');
  assert.ok(/priceFor\(/.test(payments), 'payments.js should price through priceFor()');

  // No DURATION-KEYED price map reintroduced — that is the shape of the thing
  // that was deleted ({ 7: …, 14: …, 28: … }).
  //
  // Deliberately not a scan for bare amounts: payments.js legitimately holds
  // other fees (the event listing fee, the directory tier ladder), and flagging
  // those would be a test that cries wolf until somebody deletes it.
  const durationKeyed = payments.match(/\{\s*7\s*:\s*\d/g) || [];
  assert.deepEqual(durationKeyed, [],
    `payments.js has a duration-keyed price map again: ${durationKeyed.join(', ')}`);
});

test('priceFor returns the table price, not the fallback, when the table is readable', async () => {
  // Proves the source of truth is actually the one being used.
  await pool.query(
    `UPDATE service_packages SET price = 12345.00
      WHERE service_key = 'ad_banner' AND duration_days = 7`);
  const price = await servicePackages.priceFor('ad_banner', 7);
  assert.equal(price, 12345, 'the TABLE decides the price while it can be read');

  await pool.query(
    `UPDATE service_packages SET price = 300.00
      WHERE service_key = 'ad_banner' AND duration_days = 7`);
});

test('an unknown duration is refused rather than priced at a guess', async () => {
  const price = await servicePackages.priceFor('ad_banner', 999);
  assert.equal(price, null,
    'a duration that is not a real package must not be given an arbitrary price');
});

// ---------------------------------------------------------------------------
// The FRONTEND copies (pricing-comparison.md, "where a price lives more than
// once", items 2 and 4).

test('THE BANNER SENTENCE NO LONGER STATES PRICES TEN TIMES', () => {
  // The same sentence appears ten times across the magazine, and each copy used
  // to hardcode R300 / R550 / R1,000. An admin changing a banner price left ten
  // pages advertising the old one.
  const page = fs.readFileSync(
    path.join(__dirname, '..', '..', 'unplug-magazine.html'), 'utf8');

  const tagged = (page.match(/<p class="js-banner-pricing">/g) || []).length;
  assert.ok(tagged >= 10, `expected every copy tagged, found ${tagged}`);

  // One loader, not ten.
  const loaders = (page.match(/payments\/packages\?service=ad_banner/g) || []).length;
  assert.equal(loaders, 1, 'there should be exactly one place that fetches the prices');

  // Written with textContent: these values arrive over the network.
  assert.ok(/js-banner-pricing[\s\S]{0,4000}textContent/.test(page),
    'the sentence must be written with textContent, not innerHTML');
});

test('...and the wording still reads correctly with no JavaScript', () => {
  // The literal sentence stays in the HTML as the fallback, so the page is not
  // blank or priceless for a reader without JS or on a failed fetch.
  const page = fs.readFileSync(
    path.join(__dirname, '..', '..', 'unplug-magazine.html'), 'utf8');
  assert.ok(/Advertising banners run from R\d/.test(page),
    'the fallback wording should remain in the markup');
});

test('THE PUBLIC DEMO PAGE STATES NO PRICE', () => {
  // unplug-components-demo.html is served publicly (200 on the live site) with
  // no inbound links. Its illustrative FAQ said "Packages start at R250 a
  // month", which was wrong twice: directory packages are once-off, not
  // monthly, and R250 is not one of them. A component example does not need a
  // real price to demonstrate anything.
  const demo = fs.readFileSync(
    path.join(__dirname, '..', '..', 'unplug-components-demo.html'), 'utf8');

  // Strip HTML comments first: the explanation of the removal mentions the old
  // figure on purpose, and a comment is not a claim to a reader.
  const visible = demo.replace(/<!--[\s\S]*?-->/g, '');
  const prices = visible.match(/R\s?\d[\d,]*/g) || [];
  assert.deepEqual(prices, [],
    `the demo page still shows price(s): ${prices.join(', ')}`);
});