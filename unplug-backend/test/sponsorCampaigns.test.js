// Participation Engine — Stage E: sponsor/brand campaigns, over real
// PostgreSQL. Deliberately separate from the existing ad_slots banner
// system (confirmed with the site owner) — no route exists yet, so
// these tests call the SQL functions directly, the same functions the
// routes will call via pool.query(...) once Stage F wires them up.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-sponsors-'));
const port = 11600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}
async function runMigrations() {
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }
}

async function makeSponsorship(name) {
  const result = await pool.query(
    `INSERT INTO sponsorships (sponsor_name, sponsor_logo_url, sponsor_url) VALUES ($1, 'https://example.com/logo.png', 'https://example.com') RETURNING id`,
    [name || 'Brand X']
  );
  return result.rows[0].id;
}

async function makeCampaign(sponsorshipId, overrides = {}) {
  const {
    campaignType = 'homepage',
    label = 'Presented by Brand X',
    placement = 'homepage_todays_person',
    startsAt = '2026-01-01',
    endsAt = '2026-12-31',
    isActive = true,
  } = overrides;
  const result = await pool.query(
    `INSERT INTO sponsor_campaigns (sponsorship_id, campaign_type, campaign_label, placement_code, starts_at, ends_at, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [sponsorshipId, campaignType, label, placement, startsAt, endsAt, isActive]
  );
  return result.rows[0].id;
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
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();
});

after(async () => {
  await pool.end();
  await pg.stop();
});

test('get_active_sponsor_campaign finds a campaign that is currently within its date range', async () => {
  const sponsorshipId = await makeSponsorship();
  await makeCampaign(sponsorshipId, { placement: 'test_placement_a' });

  const result = await pool.query(`SELECT * FROM get_active_sponsor_campaign('test_placement_a')`);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sponsor_name, 'Brand X');
  assert.equal(result.rows[0].campaign_label, 'Presented by Brand X');
});

test('get_active_sponsor_campaign ignores a campaign outside its date range', async () => {
  const sponsorshipId = await makeSponsorship();
  await makeCampaign(sponsorshipId, { placement: 'test_placement_b', startsAt: '2020-01-01', endsAt: '2020-12-31' });

  const result = await pool.query(`SELECT * FROM get_active_sponsor_campaign('test_placement_b')`);
  assert.equal(result.rows.length, 0);
});

test('get_active_sponsor_campaign ignores a campaign that is flagged inactive', async () => {
  const sponsorshipId = await makeSponsorship();
  await makeCampaign(sponsorshipId, { placement: 'test_placement_c', isActive: false });

  const result = await pool.query(`SELECT * FROM get_active_sponsor_campaign('test_placement_c')`);
  assert.equal(result.rows.length, 0);
});

test('get_active_sponsor_campaign ignores a campaign whose sponsor is inactive', async () => {
  const sponsorshipId = await makeSponsorship('Paused Brand');
  await pool.query('UPDATE sponsorships SET is_active = FALSE WHERE id = $1', [sponsorshipId]);
  await makeCampaign(sponsorshipId, { placement: 'test_placement_d' });

  const result = await pool.query(`SELECT * FROM get_active_sponsor_campaign('test_placement_d')`);
  assert.equal(result.rows.length, 0);
});

test('an unknown placement code (no campaigns at all) returns no rows, not an error', async () => {
  const result = await pool.query(`SELECT * FROM get_active_sponsor_campaign('nonexistent_placement')`);
  assert.equal(result.rows.length, 0);
});

test('track_sponsor_impression creates and increments the right counter for today', async () => {
  const sponsorshipId = await makeSponsorship();
  const campaignId = await makeCampaign(sponsorshipId, { placement: 'test_placement_e' });

  await pool.query(`SELECT track_sponsor_impression($1, 'impression')`, [campaignId]);
  await pool.query(`SELECT track_sponsor_impression($1, 'impression')`, [campaignId]);
  await pool.query(`SELECT track_sponsor_impression($1, 'click')`, [campaignId]);

  const row = await pool.query(
    `SELECT impressions, clicks, missions_triggered FROM sponsor_analytics WHERE campaign_id = $1 AND snapshot_date = CURRENT_DATE`,
    [campaignId]
  );
  assert.equal(row.rows[0].impressions, 2);
  assert.equal(row.rows[0].clicks, 1);
  assert.equal(row.rows[0].missions_triggered, 0);
});

test('track_sponsor_impression rejects an unknown event type rather than silently doing nothing', async () => {
  const sponsorshipId = await makeSponsorship();
  const campaignId = await makeCampaign(sponsorshipId, { placement: 'test_placement_f' });

  await assert.rejects(
    () => pool.query(`SELECT track_sponsor_impression($1, 'not_a_real_event')`, [campaignId]),
    /Unknown sponsor event type/
  );
});

test('get_sponsor_campaign_report sums analytics and computes a click rate', async () => {
  const sponsorshipId = await makeSponsorship('Report Brand');
  const campaignId = await makeCampaign(sponsorshipId, { placement: 'test_placement_g' });

  for (let i = 0; i < 10; i++) await pool.query(`SELECT track_sponsor_impression($1, 'impression')`, [campaignId]);
  for (let i = 0; i < 2; i++) await pool.query(`SELECT track_sponsor_impression($1, 'click')`, [campaignId]);

  const report = await pool.query(`SELECT * FROM get_sponsor_campaign_report($1)`, [campaignId]);
  assert.equal(report.rows[0].sponsor_name, 'Report Brand');
  assert.equal(report.rows[0].total_impressions, '10');
  assert.equal(report.rows[0].total_clicks, '2');
  assert.equal(Number(report.rows[0].click_rate), 20);
});

test('a campaign cannot be created with an end date before its start date', async () => {
  const sponsorshipId = await makeSponsorship();
  await assert.rejects(
    () => makeCampaign(sponsorshipId, { placement: 'test_placement_h', startsAt: '2026-06-01', endsAt: '2026-01-01' })
  );
});

test('re-running every migration is idempotent', async () => {
  await runMigrations();
  const fnCheck = await pool.query(`SELECT 1 AS ok FROM pg_proc WHERE proname = 'get_active_sponsor_campaign'`);
  assert.equal(fnCheck.rows.length, 1);
});
