// The nominee's social handle on the nominate form, against a REAL PostgreSQL.
//
// One box takes "@theirhandle or a link to their page", so it has to cope with
// whatever a person types off a phone. What matters:
//
//   1. a link becomes a clickable link, and a bare handle does NOT. "@thandi"
//      exists on four platforms — guessing one and putting it in front of an
//      editor sends them to a stranger's page and, on a page about ordinary
//      people, that is how the wrong person ends up in a magazine;
//   2. the admin screen renders the URL as a link an admin clicks, so nothing
//      but http(s) may ever reach that field. javascript: and data: are kept
//      as readable text but never offered as a destination;
//   3. what the nominator typed is stored verbatim. When we cannot build a
//      link, that raw text is the only clue the desk has;
//   4. it stays optional — the page exists for people who would never put
//      themselves forward, and plenty of them are not online at all.
//
// Run with:  npm test   (from unplug-backend/)

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
let parseSocialHandle;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-nomsocial-'));
const port = 32800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

// Submit a nomination and hand back the row it created.
async function nominate(fields) {
  const r = await req('POST', '/shoutouts/nominate', { nomineeName: 'Thandi Mokoena', ...fields });
  assert.equal(r.status, 201, `nomination refused: ${r.body && r.body.error}`);
  const row = await pool.query(
    'SELECT * FROM shoutout_nominations ORDER BY id DESC LIMIT 1');
  return row.rows[0];
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
  process.env.JWT_SECRET = 'test-secret-for-nomination-social';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  ({ parseSocialHandle } = require('../src/utils/socialHandle'));

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/shoutouts', require('../src/routes/shoutouts'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

// ---------------------------------------------------------------------------
// Nothing unsafe can become something an admin clicks
// ---------------------------------------------------------------------------

test('A javascript: URL NEVER BECOMES A CLICKABLE LINK', async () => {
  // The admin screen renders nominee_social_url as an <a href>. This field is
  // filled by anyone on the internet, with no sign-in.
  const row = await nominate({ nomineeSocial: 'javascript:alert(document.cookie)' });
  assert.equal(row.nominee_social_url, null, 'there is nothing safe to link to');
  assert.equal(row.nominee_social, 'javascript:alert(document.cookie)',
    'but it is kept as text so the desk can see what was submitted');
});

test('other unsafe schemes are refused a link too', async () => {
  for (const attempt of [
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'JaVaScRiPt:alert(1)',
  ]) {
    const parsed = parseSocialHandle(attempt);
    assert.equal(parsed.url, null, `${attempt} must not become a destination`);
    assert.ok(parsed.text, 'and must still be readable by the desk');
  }
});

test('http is upgraded to https rather than linked as-is', async () => {
  const row = await nominate({ nomineeSocial: 'http://instagram.com/thandi.m' });
  assert.match(row.nominee_social_url, /^https:\/\//,
    'the desk is not sent over a plain connection');
});

// ---------------------------------------------------------------------------
// A handle is a clue, not a destination
// ---------------------------------------------------------------------------

test('A BARE @HANDLE IS NOT GUESSED INTO A PLATFORM', async () => {
  // The single most important rule here. @thandi.m exists on Instagram, TikTok
  // and X, and they are three different people.
  const row = await nominate({ nomineeSocial: '@thandi.m' });
  assert.equal(row.nominee_social, '@thandi.m', 'the handle is kept exactly as given');
  assert.equal(row.nominee_social_url, null, 'and no platform is invented for it');
});

test('a plain name typed into the box is not turned into a website', async () => {
  const row = await nominate({ nomineeSocial: 'Thandi from Soweto' });
  assert.equal(row.nominee_social, 'Thandi from Soweto');
  assert.equal(row.nominee_social_url, null);
});

// ---------------------------------------------------------------------------
// A link is a link, however it was typed
// ---------------------------------------------------------------------------

test('a full URL pasted off a phone is kept as a link', async () => {
  const row = await nominate({ nomineeSocial: 'https://www.instagram.com/thandi.m/' });
  assert.match(row.nominee_social_url, /instagram\.com\/thandi\.m/);
});

test('A MISSING https:// IS FILLED IN FOR A PLATFORM WE RECOGNISE', async () => {
  // What most people actually type. Without this the commonest input would
  // arrive as unclickable text.
  for (const typed of [
    'instagram.com/thandi.m',
    'www.facebook.com/thandi.mokoena',
    'tiktok.com/@thandi.m',
    'x.com/thandim',
  ]) {
    const parsed = parseSocialHandle(typed);
    assert.match(parsed.url || '', /^https:\/\//, `"${typed}" should have become a link`);
    assert.equal(parsed.text, typed, 'and the original text is untouched');
  }
});

test('an unfamiliar domain without a scheme is not assumed to be a website', async () => {
  // "Thandi.Mokoena" is a name with a dot in it, not a host.
  const parsed = parseSocialHandle('Thandi.Mokoena');
  assert.equal(parsed.url, null);
  assert.equal(parsed.text, 'Thandi.Mokoena');
});

test('a personal website typed with https is still accepted', async () => {
  // Not on the known-host list, but they said it was a link, so it is one.
  const parsed = parseSocialHandle('https://thandimokoena.co.za/about');
  assert.equal(parsed.url, 'https://thandimokoena.co.za/about');
});

// ---------------------------------------------------------------------------
// It stays optional, and it cannot break the form
// ---------------------------------------------------------------------------

test('A NOMINATION WITHOUT A HANDLE STILL GOES THROUGH', async () => {
  // This page exists for people who would never put themselves forward, and
  // plenty of them are not online at all.
  const row = await nominate({});
  assert.equal(row.nominee_social, null);
  assert.equal(row.nominee_social_url, null);
  assert.equal(row.nominee_name, 'Thandi Mokoena', 'the nomination itself is unaffected');
});

test('an empty or whitespace-only box is stored as nothing, not as a blank', async () => {
  const row = await nominate({ nomineeSocial: '    ' });
  assert.equal(row.nominee_social, null,
    'a blank string would render as an empty link on the admin screen');
});

test('the name is still the only required field', async () => {
  const missing = await req('POST', '/shoutouts/nominate', { nomineeSocial: '@someone' });
  assert.equal(missing.status, 400, 'a handle alone is not a nomination');
});

test('an absurdly long handle is cut rather than rejected', async () => {
  // Someone pasting a tracking-laden URL should not lose their nomination.
  const row = await nominate({ nomineeSocial: 'https://instagram.com/x?' + 'a'.repeat(500) });
  assert.ok(row.nominee_social.length <= 200, 'the text is capped to fit the column');
  assert.ok(!row.nominee_social_url || row.nominee_social_url.length <= 300);
});

test('parseSocialHandle never throws, whatever it is handed', async () => {
  // It runs inside the submit path — an exception here would lose a real
  // nomination over a malformed handle.
  for (const input of [null, undefined, '', '   ', 'http://', '://nope', '@', '////',
    'https://[bad', 12345, {}, []]) {
    const parsed = parseSocialHandle(input);
    assert.ok(parsed && 'text' in parsed && 'url' in parsed,
      `parseSocialHandle(${JSON.stringify(input)}) must return a shape, not throw`);
  }
});

test('the admin queue can read the new columns', async () => {
  // The admin list selects these by name; a nomination that cannot be listed
  // is a nomination that cannot be approved.
  await nominate({ nomineeSocial: 'https://instagram.com/thandi.m' });
  const listed = await pool.query(
    `SELECT nominee_name, nominee_social, nominee_social_url
       FROM shoutout_nominations WHERE status = 'pending' ORDER BY created_at ASC`);
  assert.ok(listed.rowCount > 0);
  assert.ok(listed.rows.some((r) => r.nominee_social_url && r.nominee_social_url.includes('instagram.com')));
});

test('re-running the migrations keeps the columns and the data', async () => {
  // migrate.js re-runs every .sql on every deploy. ADD COLUMN IF NOT EXISTS
  // must not drop what is already there.
  const row = await nominate({ nomineeSocial: '@survives.the.deploy' });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const after = await pool.query('SELECT nominee_social FROM shoutout_nominations WHERE id = $1', [row.id]);
  assert.equal(after.rows[0].nominee_social, '@survives.the.deploy');
});
