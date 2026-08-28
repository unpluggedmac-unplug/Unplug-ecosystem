// Recommended image sizes, served from one place.
//
// The numbers used to be typed into each upload field by hand — about fifteen
// copies across the two dashboards — and they had already drifted:
//
//   * an EVENT image was "1600 × 900 (16:9)" on the member form and
//     "800 × 1200 (2:3 portrait)" in the admin. Opposite shapes, for the same
//     field. The site renders it landscape (.cal-thumb is 100% × 170px), so
//     the admin was the wrong one.
//   * an AD BANNER said "1920 × 600" on the member form, "1920 × 1080" in one
//     admin panel and "1920 × 600" in another — and NONE of them is a real
//     slot size. The slots are 300 × 250 and 728 × 90, stated on the public
//     page in the placeholder that sits there until a banner is sold.
//
// What these tests protect:
//
//   1. THERE IS ONE COPY OF EACH NUMBER, and it is the server's.
//   2. AD BANNER SIZES COME FROM THE PLACEMENT, because there is no single
//      banner size to state.
//   3. THE GUIDANCE IS NOT PUBLIC. It is for people filling in a form.
//
// Run with:  npm test   (from unplug-backend/)

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
let memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-imgspec-'));
const port = 46400 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
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

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-imgspec';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/image-specs', require('../src/routes/imageSpecs'));
  app.use('/ad-banners', require('../src/routes/adBanners'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (640001, 'spec@test.com', 'Spec Member', 'x', 'member')`);
  memberToken = jwt.sign({ id: 640001, email: 'spec@test.com', role: 'member' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ---------------------------------------------------------------------------

test('every spec is a usable size with a readable sentence', async () => {
  const { status, body } = await api('GET', '/image-specs', null, memberToken);
  assert.equal(status, 200);
  const keys = Object.keys(body.specs);
  assert.ok(keys.length >= 15, 'covers the images on the site, got ' + keys.length);
  keys.forEach((k) => {
    const s = body.specs[k];
    assert.ok(Number.isInteger(s.w) && s.w > 0, k + ' has no width');
    assert.ok(Number.isInteger(s.h) && s.h > 0, k + ' has no height');
    assert.ok(s.label, k + ' has no shape label');
    assert.match(s.text, /\d+ × \d+px/, k + ' has no readable sentence');
  });
});

test('THE EVENT IMAGE IS LANDSCAPE, which is what the site renders', async () => {
  // The admin said 800 × 1200 (2:3 portrait) for this. .cal-thumb img is
  // width:100%; height:170px, and the detail view caps at 220px tall — a
  // portrait upload is almost entirely cropped away.
  const { body } = await api('GET', '/image-specs', null, memberToken);
  const ev = body.specs.event_image;
  assert.ok(ev.w > ev.h, `an event image must be landscape, got ${ev.w}×${ev.h}`);
});

test('the Directory listing image is square', async () => {
  const { body } = await api('GET', '/image-specs', null, memberToken);
  const d = body.specs.directory_listing;
  assert.equal(d.w, d.h, '.dir-photo is aspect-ratio 1/1 and the listing hero is a circle');
});

test('the gallery photo is portrait, matching the 4:5 grid', async () => {
  const { body } = await api('GET', '/image-specs', null, memberToken);
  const g = body.specs.gallery_photo;
  assert.ok(g.h > g.w, 'the Gallery grid is 4:5 portrait');
  assert.ok(Math.abs((g.w / g.h) - 0.8) < 0.02, `expected ~4:5, got ${g.w}×${g.h}`);
});

test('the edition cover is a magazine shape, not a landscape banner', async () => {
  const { body } = await api('GET', '/image-specs', null, memberToken);
  const e = body.specs.edition_cover;
  assert.ok(e.h > e.w, '.home-edition-cover is 3/4');
});

// ------------------------------------------------------------- ad banners

test('AD BANNER SIZES COME FROM THE PLACEMENT', async () => {
  // There is no single ad banner size, which is why every hardcoded one was
  // wrong. A sponsor slot and a leaderboard are completely different shapes.
  const { body } = await api('GET', '/image-specs', null, memberToken);
  const slots = body.adSlots;
  assert.ok(Object.keys(slots).length >= 8);

  assert.deepEqual([slots['home-sponsor-1'].w, slots['home-sponsor-1'].h], [300, 250]);
  assert.deepEqual([slots['news-leaderboard'].w, slots['news-leaderboard'].h], [728, 90]);
  assert.notDeepEqual(
    [slots['home-sponsor-1'].w, slots['home-sponsor-1'].h],
    [slots['news-leaderboard'].w, slots['news-leaderboard'].h],
    'a sponsor slot and a leaderboard are not the same shape — one number for both cannot be right');
});

test('the buy form is told each placement\'s size', async () => {
  // The dropdown existed all along and carried no size, so the form advertised
  // one figure whatever was chosen.
  const { status, body } = await api('GET', '/ad-banners/options');
  assert.equal(status, 200);
  assert.ok(body.placements.length);
  body.placements.forEach((p) => {
    assert.ok(p.size, `${p.key} carries no size`);
    assert.match(p.size.text, /\d+ × \d+px/);
  });
  const sponsor = body.placements.find((p) => p.key === 'home-sponsor-1');
  const leader = body.placements.find((p) => p.key === 'news-leaderboard');
  assert.notEqual(sponsor.size.text, leader.size.text, 'and they differ');
});

test('every placement offered for sale has a size', async () => {
  // A placement somebody can buy but that cannot say what shape it needs is
  // the bug this whole change is about.
  const { body } = await api('GET', '/ad-banners/options');
  const missing = body.placements.filter((p) => !p.size).map((p) => p.key);
  assert.deepEqual(missing, [], 'placements with no size: ' + missing.join(', '));
});

// ---------------------------------------------------------------- privacy

test('THE GUIDANCE IS NOT PUBLIC', async () => {
  // It is for somebody filling in a submission form, and the ask was that it
  // not appear anywhere on the public site.
  assert.equal((await api('GET', '/image-specs')).status, 401);
});

// ------------------------------------------------- no second copy anywhere
//
// This is the test that matters most. Everything above checks that the list is
// right; this checks that nothing has gone back to writing its own numbers.
//
// The bug being prevented is not hypothetical — it is what was found: the same
// field stated 16:9 in one dashboard and 2:3 portrait in the other, and an ad
// banner had three different sizes across two files. Whichever one somebody
// happened to read decided what they uploaded.

const DASHBOARDS = ['unplug-member-dashboard.html', 'unplug-admin-dashboard.html'];
const siteRoot = path.join(__dirname, '..', '..');

test('NO UPLOAD FIELD WRITES ITS OWN SIZE', () => {
  // A literal { w: 1600, h: 900 } passed to an upload field is a number that
  // will drift away from the one the site actually renders.
  const offenders = [];
  DASHBOARDS.forEach((f) => {
    const src = fs.readFileSync(path.join(siteRoot, f), 'utf8');
    const re = /UnplugUpload\.fieldHtml\([^;]*?\{\s*w:\s*\d+/g;
    let m;
    while ((m = re.exec(src))) {
      offenders.push(`${f}: ${m[0].slice(0, 90).replace(/\s+/g, ' ')}`);
    }
  });
  assert.deepEqual(offenders, [],
    'these fields hardcode a size instead of asking the server:\n  ' + offenders.join('\n  '));
});

test('every upload field states a size, or is one whose size is not fixed', () => {
  // Three fields legitimately cannot name a size in the source, because it
  // depends on the row: the ad banner an admin edits (the SLOT decides), the
  // Cover Images screen (the TYPE decides), and the swappable site pictures
  // (the server sends each one's own). Everything else must name a key.
  const dynamic = ['adImage_', 'coverImg', 'siteImg-', 'abImage'];
  const silent = [];
  DASHBOARDS.forEach((f) => {
    const src = fs.readFileSync(path.join(siteRoot, f), 'utf8');
    src.split('UnplugUpload.fieldHtml(').slice(1).forEach((chunk) => {
      const head = chunk.slice(0, 400);
      const name = (head.match(/^\s*['"`]([A-Za-z0-9_\-]+)/) || [])[1] || '(computed)';
      if (dynamic.some((d) => name.startsWith(d))) return;
      // adSlotSpec / imgSpecFull, either a literal key or a variable.
      if (/imgSpecFull\(|adSlotSpec\(/.test(head)) return;
      silent.push(`${f}: ${name}`);
    });
  });
  assert.deepEqual(silent, [],
    'these upload fields tell the person nothing about what shape to bring:\n  ' + silent.join('\n  '));
});

test('every key the dashboards ask for actually exists', async () => {
  // A typo here fails silently in the browser: imgSpecFull returns undefined
  // and the field simply shows no hint, which looks exactly like "this field
  // has no recommended size" rather than like a mistake.
  const { body } = await api('GET', '/image-specs', null, memberToken);
  const missing = [];
  DASHBOARDS.forEach((f) => {
    const src = fs.readFileSync(path.join(siteRoot, f), 'utf8');
    for (const m of src.matchAll(/imgSpecFull\('([a-z_]+)'\)/g)) {
      if (!body.specs[m[1]]) missing.push(`${f}: ${m[1]}`);
    }
  });
  assert.deepEqual(missing, [], 'unknown size keys: ' + missing.join(', '));
});

test('every kind of cover an admin can change names a size', async () => {
  // The Cover Images screen covers eleven kinds of thing. One of them not
  // knowing its shape means an admin swapping, say, a Hall of Fame portrait
  // gets no guidance at all on that screen.
  const { COVERS } = require('../src/routes/adminCovers');
  const { IMAGE_SPECS } = require('../src/utils/imageSpecs');
  const bad = Object.entries(COVERS)
    .filter(([, c]) => !c.specKey || !IMAGE_SPECS[c.specKey])
    .map(([k, c]) => `${k} -> ${c.specKey || '(none)'}`);
  assert.deepEqual(bad, [], 'cover types with no usable size: ' + bad.join(', '));
});

test('the swappable site pictures use the same list, not their own numbers', () => {
  const { SITE_IMAGES } = require('../src/utils/siteImages');
  const { IMAGE_SPECS } = require('../src/utils/imageSpecs');
  const values = Object.values(IMAGE_SPECS);
  SITE_IMAGES.forEach((i) => {
    assert.ok(i.ratio, `${i.key} has no size`);
    assert.ok(values.includes(i.ratio),
      `${i.key} carries its own copy of a size instead of pointing at the list`);
  });
});
