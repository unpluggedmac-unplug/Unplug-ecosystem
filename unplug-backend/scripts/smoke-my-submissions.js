// Smoke check for the My Unplug sections (spec §4).
//
// The stop condition for these member-only views is "the automated test suite
// plus a scripted smoke check confirming the endpoint and page render" — this
// is that check. It runs the REAL app against a REAL Postgres, seeds one
// submission of every type, and asserts:
//
//   1. the endpoint answers, and answers only with that member's work
//   2. every §4 menu item returns the shape the dashboard draws
//   3. the dashboard page actually contains the section and its menu items
//
// Written to take a type, so the eleven remaining sections can reuse it rather
// than each growing a check of its own:
//
//   node scripts/smoke-my-submissions.js            # every type
//   node scripts/smoke-my-submissions.js event      # one
//
// Exits non-zero on the first failure, so it is usable in a pipeline.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const BACKEND = path.join(__dirname, '..');
const ROOT = path.join(BACKEND, '..');
const PORT_PG = 53100;
const PORT_API = 53101;

const only = process.argv[2] || null;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
  if (!ok) failures++;
}

(async () => {
  const EmbeddedPostgres = require('embedded-postgres').default;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-smoke-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PORT_PG,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  console.log('starting postgres and applying migrations...');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_smoke');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${PORT_PG}/unplug_smoke`;
  process.env.JWT_SECRET = 'smoke-secret';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const migrations = path.join(BACKEND, 'db', 'migrations');
  for (const f of fs.readdirSync(migrations).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(migrations, f), 'utf8'));
  }

  // Required AFTER DATABASE_URL is set: src/db.js builds its pool on require,
  // and a pool built without a connection string hangs rather than fails.
  // SUBMISSION_TYPES, not every type there is: highlights and the directory
// listing are services, and /my/submissions refuses them on purpose.
const { SUBMISSION_TYPES } = require(path.join(BACKEND, 'src', 'utils', 'mySubmissions'));
  const express = require('express');
  const { attachUser } = require(path.join(BACKEND, 'src', 'middleware', 'auth'));
  const jwt = require('jsonwebtoken');

  const ME = 970101;
  const OTHER = 970102;
  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES ($1,'me@smoke.test','Me','x','member'), ($2,'other@smoke.test','Other','x','member')`,
    [ME, OTHER]);

  for (const [user, tag] of [[ME, 'Mine'], [OTHER, 'Theirs']]) {
    const prof = await pool.query(
      `INSERT INTO profiles (user_id, display_name, slug, package_tier, status)
       VALUES ($1,$2,$3,'basic','approved') RETURNING id`,
      [user, `Profile ${tag}`, `smoke-${tag.toLowerCase()}`]);
    const adv = await pool.query(
      `INSERT INTO advertisers (user_id, business_name) VALUES ($1,$2) RETURNING id`,
      [user, `Adv ${tag}`]);
    const comp = await pool.query(
      `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
       VALUES ($1,$2, now() - interval '1 day', now() + interval '30 days','open') RETURNING id`,
      [`Comp ${tag}`, `smoke-comp-${tag.toLowerCase()}`]);

    await pool.query(`INSERT INTO articles (author_user_id,title,body,status)
                      VALUES ($1,$2,'body','pending')`, [user, `Article ${tag}`]);
    await pool.query(`INSERT INTO events (organizer_user_id,name,event_date,status)
                      VALUES ($1,$2,CURRENT_DATE + 10,'approved')`, [user, `Event ${tag}`]);
    await pool.query(`INSERT INTO marketplace_listings
                      (advertiser_id,poster_image_url,headline,duration_days,status)
                      VALUES ($1,'http://x/p.jpg',$2,30,'approved')`, [adv.rows[0].id, `Listing ${tag}`]);
    await pool.query(`INSERT INTO ad_slots (slot_key,image_url,name,owner_user_id,moderation_status)
                      VALUES ($1,'http://x/a.jpg',$2,$3,'pending')`,
    [`smoke-${tag.toLowerCase()}`, `Advert ${tag}`, user]);
    await pool.query(`INSERT INTO competition_entries (competition_id,profile_id,status)
                      VALUES ($1,$2,'approved')`, [comp.rows[0].id, prof.rows[0].id]);
    await pool.query(`INSERT INTO gallery_bundles (user_id,image_count,status)
                      VALUES ($1,2,'pending')`, [user]);
  }

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/my', require(path.join(BACKEND, 'src', 'routes', 'mySubmissions')));
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT_API, () => resolve(s));
  });

  const token = jwt.sign({ id: ME, email: 'me@smoke.test', role: 'member' }, process.env.JWT_SECRET);
  const get = async (p) => {
    const r = await fetch(`http://127.0.0.1:${PORT_API}${p}`,
      { headers: { Authorization: 'Bearer ' + token } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  console.log('\nendpoint:');
  const all = await get('/my/submissions');
  check('GET /my/submissions answers 200', all.status === 200, `got ${all.status}`);
  check('it returns submissions', Array.isArray(all.body && all.body.submissions));

  const leaked = (all.body.submissions || []).filter((s) => /Theirs/.test(String(s.title)));
  check('it returns ONLY this member\'s work', leaked.length === 0,
    `leaked: ${leaked.map((s) => s.title).join(', ')}`);

  const shape = ['type', 'typeLabel', 'id', 'title', 'status', 'statusLabel',
    'submittedAt', 'expiresAt', 'amount', 'paymentStatus', 'reference'].sort();
  const wrong = (all.body.submissions || []).filter(
    (s) => JSON.stringify(Object.keys(s).sort()) !== JSON.stringify(shape));
  check('every row has the shape the dashboard draws', wrong.length === 0,
    wrong.map((s) => s.type).join(', '));

  for (const type of (only ? [only] : SUBMISSION_TYPES)) {
    const one = await get(`/my/submissions?type=${type}`);
    const rows = (one.body && one.body.submissions) || [];
    check(`?type=${type} answers and is filtered`,
      one.status === 200 && rows.length > 0 && rows.every((s) => s.type === type),
      `status ${one.status}, ${rows.length} rows`);
  }

  const bad = await get('/my/submissions?type=nonsense');
  check('an unknown type is refused', bad.status === 400, `got ${bad.status}`);

  const noAuth = await fetch(`http://127.0.0.1:${PORT_API}/my/submissions`);
  check('signed out is refused', noAuth.status === 401, `got ${noAuth.status}`);

  // ---- My Services (§5): the same data read by term ----
  console.log('\nmy services:');
  const svc = await get('/my/services');
  check('GET /my/services answers 200', svc.status === 200, `got ${svc.status}`);
  check('it returns §5\'s six buckets in order',
    Array.isArray(svc.body && svc.body.groups)
      && svc.body.groups.map((g) => g.key).join(',')
        === 'awaiting_payment,requiring_changes,pending,expiring,active,expired',
    JSON.stringify(svc.body && svc.body.groups && svc.body.groups.map((g) => g.key)));
  check('it reports the database\'s today', Boolean(svc.body && svc.body.today));
  check('it says how wide the expiring window is',
    typeof (svc.body && svc.body.expiringWithinDays) === 'number');

  const svcRows = (svc.body.groups || []).flatMap((g) => g.services || []);
  check('competitions are not services',
    svcRows.every((s) => s.type !== 'competition'));
  check('service rows have the same shape the dashboard draws',
    svcRows.every((s) => 'statusLabel' in s && 'expiresAt' in s && 'typeLabel' in s));

  const svcNoAuth = await fetch(`http://127.0.0.1:${PORT_API}/my/services`);
  check('signed out is refused for services', svcNoAuth.status === 401,
    `got ${svcNoAuth.status}`);

  // ---- My Votes (§4 / Module 9) ----
  console.log('\nmy votes:');
  const votes = await get('/my/votes');
  check('GET /my/votes answers 200', votes.status === 200, `got ${votes.status}`);
  check('it separates votes cast from packages bought',
    Array.isArray(votes.body && votes.body.votes)
      && Array.isArray(votes.body && votes.body.bundles));
  check('it reports totals', typeof (votes.body && votes.body.totalVotes) === 'number'
    && typeof (votes.body && votes.body.totalSpent) === 'number');
  const votesNoAuth = await fetch(`http://127.0.0.1:${PORT_API}/my/votes`);
  check('signed out is refused for votes', votesNoAuth.status === 401,
    `got ${votesNoAuth.status}`);

  // ---- Account Settings (§4) ----
  console.log('\naccount settings:');
  const prefsGet = await get('/my/notification-preferences');
  check('GET /my/notification-preferences answers 200', prefsGet.status === 200,
    `got ${prefsGet.status}`);
  check('everything defaults to on for a member who never set it',
    prefsGet.body && prefsGet.body.preferences
      && Object.values(prefsGet.body.preferences).every((v) => v === true),
    JSON.stringify(prefsGet.body && prefsGet.body.preferences));
  check('the switches describe themselves',
    Array.isArray(prefsGet.body.fields) && prefsGet.body.fields.every((f) => f.key && f.label));

  const patched = await fetch(`http://127.0.0.1:${PORT_API}/my/notification-preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ email: false }),
  });
  const patchedBody = await patched.json().catch(() => null);
  check('a switch can actually be turned off',
    patched.status === 200 && patchedBody.preferences.email === false,
    `status ${patched.status}`);
  check('turning one off leaves the others alone',
    patchedBody.preferences.web === true && patchedBody.preferences.statusChange === true);

  const prefsNoAuth = await fetch(`http://127.0.0.1:${PORT_API}/my/notification-preferences`);
  check('signed out is refused for preferences', prefsNoAuth.status === 401,
    `got ${prefsNoAuth.status}`);

  console.log('\npage render:');
  const page = fs.readFileSync(path.join(ROOT, 'unplug-member-dashboard.html'), 'utf8');
  check('the dashboard has the My Submissions section',
    page.includes('data-ms-section="submissions"'));
  check('it has the shared renderer', page.includes('async function loadMySubmissions'));
  for (const [type, label] of [['article', 'My Articles'], ['event', 'My Events'],
    ['listing', 'My Listings'], ['advertising', 'My Advertising'],
    ['competition', 'My Competitions']]) {
    check(`the menu offers ${label}`,
      page.includes(`data-ms-type="${type}"`) && page.includes(label));
  }
  check('nothing still points at the retired Content section',
    !page.includes('data-ms-section="content"') && !page.includes('contentPendingArticles'));
  check('the dashboard has the My Services section',
    page.includes('data-ms-section="myservices"') && page.includes('>My Services<'));
  check('My Services has its loader', page.includes('async function loadMyServices'));
  check('My Services reuses subsRow rather than a second renderer',
    /function svcRender[\s\S]{0,1200}subsRow\(/.test(page));
  check('"Browse Services" is distinct from "My Services"',
    page.includes('Browse Services'));
  check('the dashboard has the My Orders section',
    page.includes('data-ms-section="myorders"') && page.includes('>My Orders<'));
  check('My Orders has its loader', page.includes('async function loadMyOrders'));
  check('My Orders shows the stored totals, not recomputed ones',
    page.includes('function ordMoney') && page.includes('order.credit_used'));
  check('the dashboard has the My Credits section',
    page.includes('data-ms-section="mycredits"') && page.includes('>My Credits<'));
  check('My Credits was MOVED out of Profile, not duplicated',
    !page.includes('<h2>Account Credits</h2>')
      && (page.match(/id="creditsContent"/g) || []).length === 1);
  check('My Credits builds nodes rather than HTML strings',
    page.includes('function creditsRender') && !/creditsContent[\s\S]{0,400}innerHTML/.test(page));
  check('the dashboard has the My Invoices section',
    page.includes('data-ms-section="myinvoices"') && page.includes('>My Invoices<'));
  check('My Invoices has its loader', page.includes('async function loadMyInvoices'));
  check('the PDF is fetched WITH the auth header, not opened as a bare link',
    page.includes('async function apiBlob')
      && /apiBlob\('\/my\/invoices\/' \+ iv\.id \+ '\/pdf'\)/.test(page));
  check('the dashboard has the My Votes section',
    page.includes('data-ms-section="myvotes"') && page.includes('>My Votes<'));
  check('My Votes has its loader', page.includes('async function loadMyVotes'));
  check('My Votes says why anonymous votes are not listed',
    /anonymous, so they cannot be listed here/.test(page));
  check('the dashboard has the Account Settings section',
    page.includes('data-ms-section="account"') && page.includes('>Account Settings<'));
  check('the password card was MOVED into it, not duplicated',
    (page.match(/id="cpwBtn"/g) || []).length === 1
      && page.indexOf('id="cpwBtn"') > page.indexOf('data-ms-section="account"'));
  check('notification switches are offered', page.includes('function notifPrefsRender'));
  check('two-factor is finally reachable by a member',
    page.includes('async function loadTwoFactor')
      && page.includes('/security/two-factor/begin'));
  check('the page does no VAT arithmetic of its own',
    !/invContent[\s\S]{0,3000}\*\s*0?\.15/.test(page)
      && !/invRender[\s\S]{0,3000}\/\s*1\.15/.test(page));

  // Shut down in order. The ROUTE has its own pool (src/db.js), separate from
  // the one this script seeds with; stopping Postgres while it still holds an
  // idle connection makes it emit an unhandled 'error' after the checks have
  // already passed, which looks like a failure and is not one.
  await new Promise((r) => server.close(r));
  const appPool = require(path.join(BACKEND, 'src', 'db'));
  appPool.on('error', () => {});   // nothing left to do about it by this point
  await appPool.end().catch(() => {});
  await pool.end().catch(() => {});
  await pg.stop();

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('smoke check crashed:', e.stack || e.message); process.exit(1); });
