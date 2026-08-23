// Two related admin changes:
//   - month + year on badges, on the badge TYPE and on each AWARD
//     (099_badge_month_year.sql), so a badge like "Top 10" can be given to
//     the same member again next month;
//   - the Top 10 appearing in the admin competitions editor, with its
//     daily-voting rule editable but frozen once voting starts.
//
// The uniqueness change is the risky part: user_badges used to carry a flat
// UNIQUE (user_id, badge_code), and the guarantee it gave for one-off badges
// must survive intact.
//
// Over real HTTP against real PostgreSQL. See universalComments.test.js for
// why require('../src/app') is avoided.
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
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-badgeperiod-'));
const port = 22000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `badgeperiod${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 52000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `badgeperiod${id}@test.com`, role]
  );
  return id;
}

let _nextCode = 0;
function freshCode() { return `test_badge_${_nextCode++}`; }

async function countAwards(userId, code) {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM user_badges WHERE user_id = $1 AND badge_code = $2',
    [userId, code]
  );
  return r.rows[0].n;
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
  process.env.JWT_SECRET = 'test-secret-for-badgeperiod';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/badges', require('../src/routes/badges'));
  app.use('/', require('../src/routes/competitions'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
});

// ---------------------------------------------------------------------------
// Badge month + year
// ---------------------------------------------------------------------------

test('a badge type can be created with a month and year, and reports them back', async () => {
  const admin = await makeUser('admin');
  const code = freshCode();
  const created = await req('POST', '/badges/admin', {
    token: tokenFor(admin, 'admin'),
    body: { code, label: 'August Top 10', description: 'Top 10 for August', emoji: '🏆', awardMonth: 8, awardYear: 2026 },
  });
  assert.equal(created.status, 201);

  const list = await req('GET', '/badges');
  const found = list.body.badges.find((b) => b.code === code);
  assert.ok(found, 'new badge missing from the public list');
  assert.equal(found.award_month, 8);
  assert.equal(found.award_year, 2026);
});

test('a month without a year (or vice versa) is rejected rather than half-stored', async () => {
  const admin = await makeUser('admin');
  const base = { label: 'X', description: 'X', emoji: '🏆' };
  for (const period of [{ awardMonth: 8 }, { awardYear: 2026 }, { awardMonth: 13, awardYear: 2026 }, { awardMonth: 8, awardYear: 1999 }]) {
    const r = await req('POST', '/badges/admin', {
      token: tokenFor(admin, 'admin'),
      body: { code: freshCode(), ...base, ...period },
    });
    assert.equal(r.status, 400, `expected rejection for ${JSON.stringify(period)}`);
  }
});

test('the SAME badge can be awarded to the same member for two different months', async () => {
  const admin = await makeUser('admin');
  const member = await makeUser();
  const code = freshCode();
  await req('POST', '/badges/admin', {
    token: tokenFor(admin, 'admin'),
    body: { code, label: 'Monthly Star', description: 'Star of the month', emoji: '⭐' },
  });

  const aug = await req('POST', `/badges/admin/${code}/award`, {
    token: tokenFor(admin, 'admin'), body: { userId: member, awardMonth: 8, awardYear: 2026 },
  });
  const sep = await req('POST', `/badges/admin/${code}/award`, {
    token: tokenFor(admin, 'admin'), body: { userId: member, awardMonth: 9, awardYear: 2026 },
  });
  assert.equal(aug.body.awarded, true);
  assert.equal(sep.body.awarded, true, 'a different month must be a genuine second award');
  assert.equal(await countAwards(member, code), 2);

  // Same month again is still a no-op.
  const augAgain = await req('POST', `/badges/admin/${code}/award`, {
    token: tokenFor(admin, 'admin'), body: { userId: member, awardMonth: 8, awardYear: 2026 },
  });
  assert.equal(augAgain.body.awarded, false);
  assert.equal(await countAwards(member, code), 2);
});

test('an UNDATED badge is still one-per-member, exactly as before', async () => {
  // The guarantee the old flat UNIQUE gave. A naive 4-column unique index
  // would have silently lost this, because Postgres treats NULLs as distinct.
  const admin = await makeUser('admin');
  const member = await makeUser();
  const code = freshCode();
  await req('POST', '/badges/admin', {
    token: tokenFor(admin, 'admin'),
    body: { code, label: 'Founding', description: 'One-off', emoji: '🌟' },
  });

  const first = await req('POST', `/badges/admin/${code}/award`, { token: tokenFor(admin, 'admin'), body: { userId: member } });
  const second = await req('POST', `/badges/admin/${code}/award`, { token: tokenFor(admin, 'admin'), body: { userId: member } });
  assert.equal(first.body.awarded, true);
  assert.equal(second.body.awarded, false, 'an undated badge must not be awardable twice');
  assert.equal(await countAwards(member, code), 1);
});

test('an award with no period inherits the badge type\'s own month and year', async () => {
  const admin = await makeUser('admin');
  const member = await makeUser();
  const code = freshCode();
  await req('POST', '/badges/admin', {
    token: tokenFor(admin, 'admin'),
    body: { code, label: 'Aug 2026 Winner', description: 'Fixed period', emoji: '🥇', awardMonth: 8, awardYear: 2026 },
  });
  const awarded = await req('POST', `/badges/admin/${code}/award`, { token: tokenFor(admin, 'admin'), body: { userId: member } });
  assert.equal(awarded.body.awarded, true);

  const mine = await req('GET', `/badges/user/${member}`);
  const row = mine.body.badges.find((b) => b.code === code);
  assert.equal(row.award_month, 8, 'award should inherit the badge type period');
  assert.equal(row.award_year, 2026);
});

test('revoking can target one month, leaving the member\'s other months intact', async () => {
  const admin = await makeUser('admin');
  const member = await makeUser();
  const code = freshCode();
  await req('POST', '/badges/admin', {
    token: tokenFor(admin, 'admin'),
    body: { code, label: 'Multi', description: 'Multi month', emoji: '📅' },
  });
  await req('POST', `/badges/admin/${code}/award`, { token: tokenFor(admin, 'admin'), body: { userId: member, awardMonth: 8, awardYear: 2026 } });
  await req('POST', `/badges/admin/${code}/award`, { token: tokenFor(admin, 'admin'), body: { userId: member, awardMonth: 9, awardYear: 2026 } });
  assert.equal(await countAwards(member, code), 2);

  const revoked = await req('DELETE', `/badges/admin/${code}/revoke/${member}?awardMonth=8&awardYear=2026`, { token: tokenFor(admin, 'admin') });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.removed, 1);
  assert.equal(await countAwards(member, code), 1);

  // Without a period it still clears every award, and says how many.
  const revokedAll = await req('DELETE', `/badges/admin/${code}/revoke/${member}`, { token: tokenFor(admin, 'admin') });
  assert.equal(revokedAll.body.removed, 1);
  assert.equal(await countAwards(member, code), 0);
});

test('the badge notification names the period when there is one', async () => {
  const admin = await makeUser('admin');
  const member = await makeUser();
  const code = freshCode();
  await req('POST', '/badges/admin', {
    token: tokenFor(admin, 'admin'),
    body: { code, label: 'Periodic', description: 'D', emoji: '🎖' },
  });
  await req('POST', `/badges/admin/${code}/award`, { token: tokenFor(admin, 'admin'), body: { userId: member, awardMonth: 8, awardYear: 2026 } });
  const note = await pool.query(`SELECT title FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [member]);
  assert.match(note.rows[0].title, /August 2026/);
});

test('redefining award_badge kept the follower fan-out and the notify kill switch', async () => {
  // 099 rewrites award_badge wholesale, so it has to carry forward what
  // 093_following_activity_feed.sql added. Dropping either is silent — the
  // award still succeeds, it just stops reaching followers. Asserted here as
  // well as in followingActivityFeed.test.js because THIS file is the one
  // that changes the function.
  const admin = await makeUser('admin');
  const member = await makeUser();
  const follower = await makeUser();
  await pool.query(
    'INSERT INTO member_follows (follower_user_id, followed_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [follower, member]
  );

  const code = freshCode();
  await req('POST', '/badges/admin', {
    token: tokenFor(admin, 'admin'),
    body: { code, label: 'Fanned Out', description: 'D', emoji: '📣' },
  });
  await req('POST', `/badges/admin/${code}/award`, {
    token: tokenFor(admin, 'admin'), body: { userId: member, awardMonth: 8, awardYear: 2026 },
  });

  const fan = await pool.query(
    `SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'following_activity'`,
    [follower]
  );
  assert.equal(fan.rowCount, 1, 'the follower should have been notified');
  assert.match(fan.rows[0].body, /Fanned Out/);

  // And the recipient's own badge notification respects its kill switch.
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('notify_badge_enabled', 'false')
     ON CONFLICT (key) DO UPDATE SET value = 'false'`
  );
  const member2 = await makeUser();
  await req('POST', `/badges/admin/${code}/award`, {
    token: tokenFor(admin, 'admin'), body: { userId: member2, awardMonth: 9, awardYear: 2026 },
  });
  const suppressed = await pool.query(
    `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'badge'`, [member2]
  );
  assert.equal(suppressed.rowCount, 0, 'notify_badge_enabled=false should suppress the badge notification');
  await pool.query(`UPDATE settings SET value = 'true' WHERE key = 'notify_badge_enabled'`);
});

test('an admin can award a DISABLED badge, and is told it is disabled', async () => {
  // The admin panel lists every badge type, so a disabled one is offered.
  // It used to be silently unawardable, reported with the same message as a
  // genuine duplicate — two different outcomes that looked identical.
  const admin = await makeUser('admin');
  const member = await makeUser();
  const code = freshCode();
  await req('POST', '/badges/admin', {
    token: tokenFor(admin, 'admin'),
    body: { code, label: 'Retired Badge', description: 'No longer offered', emoji: '🎗' },
  });
  await req('PATCH', `/badges/admin/${code}`, { token: tokenFor(admin, 'admin'), body: { isEnabled: false } });

  const awarded = await req('POST', `/badges/admin/${code}/award`, {
    token: tokenFor(admin, 'admin'), body: { userId: member },
  });
  assert.equal(awarded.status, 200);
  assert.equal(awarded.body.awarded, true, 'a disabled badge should still be awardable by an admin');
  assert.equal(awarded.body.badgeDisabled, true, 'the admin should be told it is disabled');
  assert.equal(await countAwards(member, code), 1);

  // It stays out of the PUBLIC obtainable list, which is what is_enabled is for.
  const publicList = await req('GET', '/badges');
  assert.equal(publicList.body.badges.some((b) => b.code === code), false);

  // But the member genuinely holds it.
  const held = await req('GET', `/badges/user/${member}`);
  assert.ok(held.body.badges.some((b) => b.code === code));
});

test('awarding a badge code that does not exist is a 404, not a silent false', async () => {
  const admin = await makeUser('admin');
  const member = await makeUser();
  const r = await req('POST', '/badges/admin/no_such_badge_code/award', {
    token: tokenFor(admin, 'admin'), body: { userId: member },
  });
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// Top 10 in the competitions editor
// ---------------------------------------------------------------------------

test('the Top 10 now appears in the admin competitions list, flagged as managed elsewhere', async () => {
  const admin = await makeUser('admin');
  const { status, body } = await req('GET', '/competitions/admin/all', { token: tokenFor(admin, 'admin') });
  assert.equal(status, 200);
  const top10 = body.competitions.find((c) => c.slug === 'top-10');
  assert.ok(top10, 'Top 10 should no longer be hidden from the editor');
  assert.equal(top10.daily_voting, true);
  assert.equal(top10.managedElsewhere, true, 'its entries are still managed on their own screen');

  const arena = body.competitions.find((c) => c.slug === 'the-arena');
  assert.equal(arena.managedElsewhere, false);
  // has_votes drives whether the admin UI offers the voting-rule control.
  assert.equal(typeof top10.has_votes, 'boolean');
});

test('has_votes flips once someone votes, so the UI can lock the voting rule', async () => {
  const admin = await makeUser('admin');
  const owner = await makeUser();
  const comp = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
     VALUES ('Has Votes Check', 'has-votes-check', now(), now() + interval '30 days', 'open') RETURNING id`
  );
  const profile = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', 'has-votes-p', 'Votes Check', 'approved') RETURNING id`,
    [owner]
  );
  const entry = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [comp.rows[0].id, profile.rows[0].id]
  );

  const listBefore = await req('GET', '/competitions/admin/all', { token: tokenFor(admin, 'admin') });
  assert.equal(listBefore.body.competitions.find((c) => c.id === comp.rows[0].id).has_votes, false);

  await req('POST', `/entries/${entry.rows[0].id}/vote`, { token: tokenFor(await makeUser()) });

  const listAfter = await req('GET', '/competitions/admin/all', { token: tokenFor(admin, 'admin') });
  assert.equal(listAfter.body.competitions.find((c) => c.id === comp.rows[0].id).has_votes, true);
});

test('daily voting can be toggled while a competition has no votes', async () => {
  const admin = await makeUser('admin');
  const comp = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
     VALUES ('Toggle Me', 'toggle-me', now(), now() + interval '30 days', 'open') RETURNING id, daily_voting`
  );
  assert.equal(comp.rows[0].daily_voting, false);

  const on = await req('PATCH', `/competitions/${comp.rows[0].id}`, {
    token: tokenFor(admin, 'admin'), body: { dailyVoting: true },
  });
  assert.equal(on.status, 200);
  const after = await pool.query('SELECT daily_voting FROM competitions WHERE id = $1', [comp.rows[0].id]);
  assert.equal(after.rows[0].daily_voting, true);
});

test('daily voting CANNOT be changed once voting has started', async () => {
  const admin = await makeUser('admin');
  const owner = await makeUser();
  const comp = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
     VALUES ('Frozen Rules', 'frozen-rules', now(), now() + interval '30 days', 'open') RETURNING id`
  );
  const profile = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', 'frozen-rules-p', 'Frozen Entrant', 'approved') RETURNING id`,
    [owner]
  );
  const entry = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [comp.rows[0].id, profile.rows[0].id]
  );
  await req('POST', `/entries/${entry.rows[0].id}/vote`, { token: tokenFor(await makeUser()) });

  const blocked = await req('PATCH', `/competitions/${comp.rows[0].id}`, {
    token: tokenFor(admin, 'admin'), body: { dailyVoting: true },
  });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /already started/);

  // Editing something unrelated is still fine.
  const renamed = await req('PATCH', `/competitions/${comp.rows[0].id}`, {
    token: tokenFor(admin, 'admin'), body: { name: 'Frozen Rules Renamed' },
  });
  assert.equal(renamed.status, 200);
});

test('re-running every migration is idempotent — badge periods and awards survive', async () => {
  const admin = await makeUser('admin');
  const member = await makeUser();
  const code = freshCode();
  await req('POST', '/badges/admin', {
    token: tokenFor(admin, 'admin'),
    body: { code, label: 'Idempotent', description: 'D', emoji: '🔁' },
  });
  await req('POST', `/badges/admin/${code}/award`, { token: tokenFor(admin, 'admin'), body: { userId: member, awardMonth: 8, awardYear: 2026 } });

  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  assert.equal(await countAwards(member, code), 1);
  // And awarding still behaves: same month no-op, new month allowed.
  const same = await req('POST', `/badges/admin/${code}/award`, { token: tokenFor(admin, 'admin'), body: { userId: member, awardMonth: 8, awardYear: 2026 } });
  assert.equal(same.body.awarded, false);
  const next = await req('POST', `/badges/admin/${code}/award`, { token: tokenFor(admin, 'admin'), body: { userId: member, awardMonth: 9, awardYear: 2026 } });
  assert.equal(next.body.awarded, true);
});
