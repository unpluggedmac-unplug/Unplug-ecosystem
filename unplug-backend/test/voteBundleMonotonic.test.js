// Buying more votes must never cost less than buying fewer.
//
// docs/pricing-comparison.md, decision 3. The 70/150/200/300-vote tiers were
// each priced worse per vote than the 50-vote tier — a voter who noticed could
// buy 50 + 50 (100 votes, R40) for less than the official 70-vote tier (R50).
// Migration 169 flattened everything from 50 votes up to the 50-tier's own
// rate, R0.40/vote. This is not just "the six numbers are right" — it is the
// actual property that was missing, checked the way a voter arbitraging the
// tiers would find it: by trying combinations.

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-votebundle-'));
const port = 58500 + (process.pid % 300);

before(async () => {
  ensureStopWords();
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: `postgres://postgres:postgres@localhost:${port}/unplug_test` });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
});

after(async () => {
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

async function tiers() {
  const r = await pool.query('SELECT votes, price FROM vote_bundle_tiers ORDER BY votes ASC');
  return r.rows.map((row) => ({ votes: row.votes, price: Number(row.price) }));
}

test('10 and 50 votes are unchanged — the fix lowered the tiers above them, not these', async () => {
  const list = await tiers();
  assert.deepEqual(list.find((t) => t.votes === 10), { votes: 10, price: 10 });
  assert.deepEqual(list.find((t) => t.votes === 50), { votes: 50, price: 20 });
});

test('EVERY TIER FROM 50 VOTES UP CHARGES THE SAME RATE, R0.40/VOTE', async () => {
  const list = await tiers();
  for (const t of list) {
    if (t.votes < 50) continue;
    assert.equal(t.price / t.votes, 0.4, `${t.votes} votes should be R0.40/vote, is R${t.price / t.votes}/vote`);
  }
});

test('PER-VOTE RATE NEVER INCREASES AS THE TIER GETS BIGGER', async () => {
  const list = await tiers();
  let prevRate = Infinity;
  for (const t of list) {
    const rate = t.price / t.votes;
    assert.ok(rate <= prevRate + 1e-9,
      `${t.votes} votes is R${rate}/vote, worse than the smaller tier before it (R${prevRate}/vote)`);
    prevRate = rate;
  }
});

test('NO COMBINATION OF SMALLER TIERS BEATS A LARGER TIER FOR THE SAME OR FEWER VOTES', async () => {
  // The actual bug, checked the way a voter would find it: try buying the
  // official tier N times, for every tier and every count up to a full ladder,
  // and confirm nothing cheaper turns up for at least as many votes.
  const list = await tiers();
  const combos = [];
  for (const t of list) {
    for (let n = 1; n <= 5; n += 1) combos.push({ votes: t.votes * n, price: t.price * n, via: `${n}x ${t.votes}` });
  }
  for (const target of list) {
    const cheaper = combos.find((c) => c.votes >= target.votes && c.price < target.price - 0.001);
    assert.equal(cheaper, undefined,
      cheaper && `buying ${cheaper.via} gives ${cheaper.votes} votes for R${cheaper.price}, `
        + `beating the official ${target.votes}-vote tier at R${target.price}`);
  }
});

test('MIGRATION 169 SURVIVES BEING RE-RUN', async () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '169_vote_bundle_monotonic_pricing.sql'), 'utf8');
  await assert.doesNotReject(() => pool.query(sql));
  await assert.doesNotReject(() => pool.query(sql));

  const list = await tiers();
  assert.deepEqual(list.map((t) => t.price), [10, 20, 28, 60, 80, 120]);
});
