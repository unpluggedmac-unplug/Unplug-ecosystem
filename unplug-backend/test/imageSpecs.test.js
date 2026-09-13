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
let adminToken;
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
  app.use('/page-cms', require('../src/routes/pageContent'));
  app.use('/admin', require('../src/routes/admin'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (640001, 'spec@test.com', 'Spec Member', 'x', 'member')`);
  memberToken = jwt.sign({ id: 640001, email: 'spec@test.com', role: 'member' }, process.env.JWT_SECRET);
  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (640002, 'specadmin@test.com', 'Spec Admin', 'x', 'admin')`);
  adminToken = jwt.sign({ id: 640002, email: 'specadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
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
  // These fields legitimately cannot name a size in the source, because it
  // depends on the row: the ad banner an admin edits (the SLOT decides), the
  // Cover Images screen (the TYPE decides), the swappable site pictures (the
  // server sends each one's own), and the article cover image and each
  // section's own picture (the chosen landscape/portrait ORIENTATION decides
  // — see artCoverSpecFor/artSectionImageSpecFor and their matching
  // artCoverOrientation/artWireSectionOrientation wiring in both dashboard
  // files, all of which still call imgSpecFull() themselves, just one layer
  // removed from this literal scan). Everything else must name a key.
  const dynamic = ['adImage_', 'coverImg', 'siteImg-', 'abImage', 'cover', 'bannerImage', 'sectionImage', 'mediaLibraryUpload'];
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

// ------------------------------------------- the shape of a slot once it sells
//
// The sizes above are what the buy form recommends and what the empty
// placeholder on the page advertises. This section is about the other half of
// the same promise: what the slot looks like once a banner is actually in it.
//
// It used to break that promise. Every filled slot was `aspect-ratio:16/9`
// with `object-fit:contain`, one box for all of them, so a 728 x 90
// leaderboard — sold as a leaderboard, uploaded as a leaderboard, and
// advertised as "728x90 Leaderboard" by the placeholder that sat in that exact
// spot until it sold — rendered as a thin strip floating in a tall empty box.
// The empty slot promised one shape and the filled slot drew another.
//
// The 16:9 was not arbitrary and the fix had to keep what it was for: several
// banners rotate through one slot, so the box must not resize per banner or
// the page moves under the reader every few seconds. The ratio is therefore
// still FIXED — just fixed per slot, at the format that slot sells, instead of
// one guess for all of them.

test('A SOLD SLOT IS SHAPED LIKE THE FORMAT IT SELLS', async () => {
  await pool.query(`INSERT INTO ad_slots (slot_key, image_url, is_active)
                    VALUES ('news-leaderboard', 'https://a.test/lead.jpg', true),
                           ('home-sponsor-1',   'https://a.test/spon.jpg', true)`);
  const { status, body } = await api('GET', '/page-cms');
  assert.equal(status, 200);
  assert.ok(body.adSlotSizes, 'the public payload carries no slot shapes at all');

  const lead = body.adSlotSizes['news-leaderboard'];
  const spon = body.adSlotSizes['home-sponsor-1'];
  assert.deepEqual([lead.w, lead.h], [728, 90], 'a leaderboard must render as a leaderboard');
  assert.deepEqual([spon.w, spon.h], [300, 250]);

  // The specific bug: 16:9 for a 728 x 90 banner is over eight times too tall,
  // and `contain` turns all of that into empty background.
  assert.ok(Math.abs((lead.w / lead.h) - (16 / 9)) > 0.5,
    'a leaderboard is nothing like 16:9 — that is what was letterboxing it');
  assert.notDeepEqual([lead.w, lead.h], [spon.w, spon.h],
    'one ratio cannot be right for both, which is why a single 16/9 was wrong');
});

test('THE RATIO IS THE SLOT\'S, NOT THE BANNER\'S', async () => {
  // This is the property the old 16:9 had and that the fix must not lose.
  // Three banners rotate in one slot; if the box followed each banner's own
  // picture, the page would jump every time the carousel advanced. The size is
  // therefore keyed by SLOT, and adding banners to a slot cannot change it.
  const before = (await api('GET', '/page-cms')).body.adSlotSizes['gallery-sponsor'];
  assert.equal(before, undefined, 'nothing sold in this slot yet');

  await pool.query(`INSERT INTO ad_slots (slot_key, image_url, is_active) VALUES
    ('gallery-sponsor', 'https://a.test/g1.jpg', true),
    ('gallery-sponsor', 'https://a.test/g2.jpg', true),
    ('gallery-sponsor', 'https://a.test/g3.jpg', true)`);

  const { body } = await api('GET', '/page-cms');
  assert.equal(body.adSlots['gallery-sponsor'].length, 3, 'three banners rotating here');
  assert.deepEqual([body.adSlotSizes['gallery-sponsor'].w, body.adSlotSizes['gallery-sponsor'].h],
    [300, 250], 'one shape for the slot, whatever is rotating through it');
  assert.equal(Object.keys(body.adSlotSizes).filter((k) => k === 'gallery-sponsor').length, 1,
    'one entry per slot, not one per banner');
});

test('the mobile file gets its own shape, because it is a different format', async () => {
  // <source media="(max-width:640px)"> swaps in ad_banner_mobile, which is
  // 300 x 250 — a wide leaderboard is unreadable on a phone. Without a mobile
  // ratio the slot would keep its 728 x 90 box and letterbox that instead,
  // which is the same bug moved to a smaller screen.
  const { body } = await api('GET', '/page-cms');
  const lead = body.adSlotSizes['news-leaderboard'];
  const { IMAGE_SPECS } = require('../src/utils/imageSpecs');
  assert.deepEqual([lead.mobileW, lead.mobileH],
    [IMAGE_SPECS.ad_banner_mobile.w, IMAGE_SPECS.ad_banner_mobile.h],
    'the mobile shape must come from ad_banner_mobile, not a second copy of it');
  assert.notDeepEqual([lead.mobileW, lead.mobileH], [lead.w, lead.h],
    'a leaderboard and its phone version are different shapes');
});

test('THE FILLED SLOT MATCHES THE EMPTY PLACEHOLDER STANDING IN IT', () => {
  // The heart of it. Each empty slot on the public page advertises its format
  // in words — "Advertisement - 728x90 Leaderboard". That text and the box the
  // banner lands in are two statements of one number, which is precisely how
  // ad sizes drifted into three different answers before. Whenever the
  // placeholder names a size, it must be the size the slot renders at.
  const { AD_SLOT_SIZES } = require('../src/utils/imageSpecs');
  const html = fs.readFileSync(path.join(siteRoot, 'unplug-magazine.html'), 'utf8');
  const disagreements = [];
  const unknown = [];
  for (const m of html.matchAll(/<div[^>]*data-ad-slot="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)) {
    const [, key, inner] = m;
    const spec = AD_SLOT_SIZES[key];
    if (!spec) { unknown.push(key); continue; }
    const stated = inner.match(/(\d{2,4})\s*[x\u00d7]\s*(\d{2,4})/);
    if (!stated) continue; // some slots word it without a size; nothing to contradict
    if (Number(stated[1]) !== spec.w || Number(stated[2]) !== spec.h) {
      disagreements.push(`${key}: the page says ${stated[1]}x${stated[2]}, the slot renders ${spec.w}x${spec.h}`);
    }
  }
  assert.deepEqual(unknown, [], 'slots on the page with no size on the server: ' + unknown.join(', '));
  assert.deepEqual(disagreements, [],
    'the empty slot promises one shape and the filled slot draws another:\n  ' + disagreements.join('\n  '));
});

test('NO SLOT SIZE IS WRITTEN DOWN A SECOND TIME IN THE STYLESHEET', () => {
  // The fix would be self-defeating if it moved the numbers into the CSS: that
  // is the same drift, one file over. `.ad-slot-filled` must take its shape
  // from a custom property the server fills in, and the only ratio allowed to
  // appear literally is the 16/9 fallback that preserves the old rendering for
  // a slot the server says nothing about.
  const html = fs.readFileSync(path.join(siteRoot, 'unplug-magazine.html'), 'utf8');
  const rule = html.match(/\.ad-slot-filled\{[\s\S]*?\}/);
  assert.ok(rule, '.ad-slot-filled is gone');
  assert.match(rule[0], /aspect-ratio:\s*var\(--ad-slot-ratio/,
    '.ad-slot-filled must take its shape from the slot, not state one');

  const literals = [];
  for (const m of html.matchAll(/\.ad-slot-filled[^{]*\{[^}]*aspect-ratio:\s*([^;]+);/g)) {
    const value = m[1].trim();
    if (/^var\(--ad-slot-ratio(-mobile)?,/.test(value)) continue;
    literals.push(value);
  }
  assert.deepEqual(literals, [],
    'these hardcode a banner shape instead of asking the slot: ' + literals.join(', '));
});

test('nothing else quietly overrides the slot\'s own shape', () => {
  // The staging interaction layer used to set an inline aspect-ratio from the
  // ACTIVE BANNER's own pixels, which both beats the stylesheet and is
  // per-banner — the page movement this whole thing exists to prevent. It has
  // to stand down for a slot that knows its own format, or staging renders
  // these differently from production and verifying anything there is
  // meaningless.
  const js = fs.readFileSync(
    path.join(siteRoot, 'media', 'scripts', 'unplug-image-interactions.js'), 'utf8');
  const fn = js.match(/function adaptBannerSlot\(slot\)\{?[\s\S]*?\n  \}/);
  assert.ok(fn, 'adaptBannerSlot is gone — check nothing else sets a banner ratio');
  // Comments stripped first: a note SAYING it defers is not deferring, and an
  // earlier version of this test passed on the comment alone after the guard
  // itself had been deleted.
  const code = fn[0].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const guard = code.indexOf('--ad-slot-ratio');
  const write = code.indexOf('style.aspectRatio');
  assert.ok(guard !== -1,
    'adaptBannerSlot must leave a slot that declares its own ratio alone');
  assert.ok(write === -1 || guard < write,
    'the check must come before it writes an aspect-ratio, or it writes anyway');
  assert.match(code.slice(guard, write === -1 ? undefined : write), /\breturn\b/,
    'the check must actually bail out, not merely read the property');
});

// --------------------------------------- the admin's say over a slot's format
//
// The standard formats above are defaults, not law. An admin can set a
// different size for any slot without a deploy — and the reason this is worth
// testing hard is that a size is the value this codebase has most often ended
// up stating twice and then contradicting itself about. An override that only
// reached the public page, while the upload form kept recommending the old
// size, would recreate exactly that: somebody uploads 728 x 90 because the form
// said so, into a slot the admin has made 970 x 250.

const FORMATS_KEY = 'ad_slot_formats';

async function setFormats(obj) {
  return api('PATCH', '/admin/settings/' + FORMATS_KEY, { value: JSON.stringify(obj) }, adminToken);
}

test('the setting exists and starts empty, so every slot is on its default', async () => {
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', [FORMATS_KEY]);
  assert.equal(r.rows.length, 1, 'migration 211 did not seed the setting');
  // Empty rather than a copy of AD_SLOT_SIZES on purpose: a second copy of
  // those numbers in the database is the drift this area keeps suffering from.
  assert.deepEqual(JSON.parse(r.rows[0].value), {});
});

test('AN ADMIN CHANGES A SLOT AND EVERY PLACE THAT STATES A SIZE FOLLOWS', async () => {
  const { status } = await setFormats({ 'news-leaderboard': { w: 970, h: 250 } });
  assert.equal(status, 200);

  // 1. what the public page renders the banner at
  const pub = (await api('GET', '/page-cms')).body.adSlotSizes['news-leaderboard'];
  assert.deepEqual([pub.w, pub.h], [970, 250]);

  // 2. what the dashboards tell whoever uploads the banner
  const hint = (await api('GET', '/image-specs', null, memberToken)).body.adSlots['news-leaderboard'];
  assert.deepEqual([hint.w, hint.h], [970, 250]);

  // 3. what the buy form quotes to whoever is paying for it
  const buy = (await api('GET', '/ad-banners/options')).body.placements
    .find((p) => p.key === 'news-leaderboard');
  assert.deepEqual([buy.size.w, buy.size.h], [970, 250]);

  // All three from one resolver — if they can disagree, the bug is back.
  assert.equal(hint.text, buy.size.text, 'the upload hint and the buy form must word it identically');
});

test('a changed slot stops claiming to be the format it no longer is', async () => {
  // "728 x 90 (Leaderboard)" is a standard format with a standard name. Once an
  // admin sets 970 x 250 the number is theirs but the NAME would be a lie, so
  // it is dropped rather than carried onto a size it does not describe.
  const hint = (await api('GET', '/image-specs', null, memberToken)).body.adSlots['news-leaderboard'];
  assert.equal(hint.label, null, 'a custom size must not keep the standard format\'s name');
  assert.equal(hint.customised, true);
  assert.doesNotMatch(hint.text, /Leaderboard/);

  const untouched = (await api('GET', '/image-specs', null, memberToken)).body.adSlots['about-leaderboard'];
  assert.equal(untouched.label, 'Leaderboard', 'an untouched slot keeps its name');
  assert.equal(untouched.customised, false);
});

test('clearing an override puts the slot back on the standard format', async () => {
  await setFormats({});
  const { AD_SLOT_SIZES } = require('../src/utils/imageSpecs');
  const hint = (await api('GET', '/image-specs', null, memberToken)).body.adSlots['news-leaderboard'];
  assert.deepEqual([hint.w, hint.h], [AD_SLOT_SIZES['news-leaderboard'].w, AD_SLOT_SIZES['news-leaderboard'].h]);
  assert.equal(hint.label, 'Leaderboard');
  // And the override really is gone from the database, not stored as a copy of
  // the default — which would silently stop following a later change in source.
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', [FORMATS_KEY]);
  assert.deepEqual(JSON.parse(r.rows[0].value), {});
});

test('A MISTYPED SIZE IS REFUSED, NOT PUT ON THE PUBLIC SITE', async () => {
  // This drives the height of a box on a live page: 7280 x 9 is a wall of empty
  // space, and on a phone an unscrollable one. Each of these must come back as
  // a 400 with a reason, and must not change what is stored.
  const bad = [
    [{ 'news-leaderboard': { w: 728 } }, 'a width with no height'],
    [{ 'news-leaderboard': { w: 0, h: 90 } }, 'a zero width'],
    [{ 'news-leaderboard': { w: 99999, h: 90 } }, 'a width past the limit'],
    [{ 'news-leaderboard': { w: 72.5, h: 90 } }, 'a fractional width'],
    [{ 'news-leaderboard': { w: '728px', h: 90 } }, 'a width with units in it'],
    [{ 'not-a-real-slot': { w: 728, h: 90 } }, 'a slot that does not exist'],
    [{ 'news-leaderboard': { w: 728, h: 90, fit: 'yes' } }, 'a non-boolean fit'],
    [{ 'news-leaderboard': 'wide' }, 'a slot that is not an object'],
  ];
  for (const [payload, why] of bad) {
    const { status, body } = await setFormats(payload);
    assert.equal(status, 400, `${why} was accepted`);
    assert.ok(body.error && body.error.length > 10, `${why} was refused without saying why`);
  }
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', [FORMATS_KEY]);
  assert.deepEqual(JSON.parse(r.rows[0].value), {}, 'a refused change must not have been stored');
});

test('only an admin can change what the public page renders', async () => {
  assert.equal((await setFormats({})).status, 200);
  const asMember = await api('PATCH', '/admin/settings/' + FORMATS_KEY,
    { value: '{}' }, memberToken);
  assert.ok(asMember.status === 401 || asMember.status === 403,
    'a member changed an ad slot format, got ' + asMember.status);
});

test('a corrupt setting falls back to the defaults instead of breaking the page', async () => {
  // Read on every public page load. Whatever is in that row, the magazine has
  // to render — so parsing is forgiving on the way out and strict on the way in.
  const { resolveAdSlotSizes } = require('../src/utils/adSlotFormats');
  const { AD_SLOT_SIZES } = require('../src/utils/imageSpecs');
  ['', 'not json at all', '[]', 'null', '{"news-leaderboard":{"w":"wide"}}'].forEach((raw) => {
    const r = resolveAdSlotSizes(raw);
    assert.deepEqual([r['news-leaderboard'].w, r['news-leaderboard'].h],
      [AD_SLOT_SIZES['news-leaderboard'].w, AD_SLOT_SIZES['news-leaderboard'].h],
      `"${raw}" should have fallen back to the default`);
  });
});

// ------------------------------------------------------- scale, not just shape
//
// Getting the RATIO right is only half of it. A 300 x 250 stretched across a
// 1240px column is a 1033px-tall slab of artwork upscaled four times over —
// the right shape at a scale nobody bought, and no more honest than the 16:9
// box it replaced.

test('A SLOT IS NOT DRAWN WIDER THAN THE FORMAT IT SELLS', async () => {
  const { body } = await api('GET', '/page-cms');
  const lead = body.adSlotSizes['news-leaderboard'];
  assert.equal(lead.fit, true, 'by default a banner renders at its own size, centred');

  const html = fs.readFileSync(path.join(siteRoot, 'unplug-magazine.html'), 'utf8');
  const rule = html.match(/\.ad-slot-filled\{[\s\S]*?\}/)[0];
  assert.match(rule, /max-width:\s*var\(--ad-slot-max-w/,
    'the slot must be able to cap its own width');
  assert.match(rule, /margin-left:\s*auto/, 'and be centred when it does');
});

test('an admin can still let a banner span the column', async () => {
  // Unticking the box is a deliberate choice to stretch the artwork, so it has
  // to survive the round trip rather than being normalised away.
  const { status } = await setFormats({ 'news-leaderboard': { fit: false } });
  assert.equal(status, 200);
  const { body } = await api('GET', '/page-cms');
  assert.equal(body.adSlotSizes['news-leaderboard'].fit, false);
  await setFormats({});
});

test('THE SIZE GUIDANCE SURVIVES THE DATABASE BEING UNREACHABLE', async () => {
  // Regression. This endpoint was pure data until ad slot formats became
  // admin-editable; adding the settings lookup coupled it to the database and
  // two existing tests — which mount it in a bare app with no database at all —
  // started getting Express's HTML error page instead of JSON.
  //
  // Serving the standard formats is the correct answer here, not a 500: it is
  // what every slot used before an override was possible, the caller is
  // read-only, and the dashboards already treat missing guidance as survivable
  // rather than fatal. The backend also sleeps on Render's free tier, so a
  // failed query is ordinary.
  const express = require('express');
  const { resolveAdSlotSizes, loadAdSlotSizes } = require('../src/utils/adSlotFormats');
  const { AD_SLOT_SIZES } = require('../src/utils/imageSpecs');

  const brokenPool = { query: () => Promise.reject(new Error('no database here')) };
  const fallback = await loadAdSlotSizes(brokenPool);
  assert.deepEqual(fallback, resolveAdSlotSizes(null), 'a failed lookup must give the standard formats');
  assert.deepEqual([fallback['news-leaderboard'].w, fallback['news-leaderboard'].h],
    [AD_SLOT_SIZES['news-leaderboard'].w, AD_SLOT_SIZES['news-leaderboard'].h]);

  // And end to end: the route mounted with no database still answers in JSON,
  // which is exactly the shape the two orientation tests rely on.
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1, role: 'member' }; next(); });
  app.use('/image-specs', require('../src/routes/imageSpecs'));
  const bare = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
  try {
    const res = await fetch(`http://127.0.0.1:${bare.address().port}/image-specs`);
    assert.equal(res.status, 200, 'the hint endpoint must not 500 when a settings row cannot be read');
    const parsed = await res.json();
    assert.ok(parsed.specs.article_cover_landscape, 'the image specs are still served');
    assert.deepEqual([parsed.adSlots['news-leaderboard'].w, parsed.adSlots['news-leaderboard'].h],
      [AD_SLOT_SIZES['news-leaderboard'].w, AD_SLOT_SIZES['news-leaderboard'].h]);
  } finally {
    await new Promise((resolve) => bare.close(resolve));
  }
});

test('A CAPPED SLOT STILL HAS A WIDTH — the grid-item collapse', () => {
  // Found on the live site, not in a test: the three homepage sponsor slots are
  // GRID ITEMS (.ad-card inside .grid-3). Capping the slot added
  // `margin-inline:auto`, and an auto inline margin on a grid item turns OFF
  // stretch alignment, so the box sizes to its max-content rather than the
  // track. Every child of a filled slot is position:absolute (.ad-slide), so
  // max-content is ZERO: all three slots collapsed to 0x0 and three paying
  // advertisers' banners vanished from the homepage entirely — a worse outcome
  // than the letterboxing the cap was added to fix.
  //
  // `width:100%` gives the box a definite width in any container and still
  // centres within the cap. This test exists because nothing node-based can
  // catch a layout collapse; the only guard available here is that the
  // declaration cannot be quietly dropped as redundant.
  const html = fs.readFileSync(path.join(siteRoot, 'unplug-magazine.html'), 'utf8');
  const rule = html.match(/\.ad-slot-filled\{[\s\S]*?\n\}/)[0];
  const capped = /max-width:\s*var\(--ad-slot-max-w/.test(rule);
  const autoMargin = /margin-left:\s*auto/.test(rule);
  if (capped || autoMargin) {
    assert.match(rule, /(^|[;\s])width:\s*100%/,
      'a slot that caps its width or centres itself MUST also state width:100%, '
      + 'or it collapses to 0x0 wherever it is a grid item');
  }
});

test('A MOBILE SIZE THE ADMIN CHOSE IS APPLIED EVEN WITH NO MOBILE ARTWORK', () => {
  // The DEFAULT mobile size is gated on every banner in the slot having a
  // mobile file, because otherwise the <picture> falls back to the wide
  // desktop image and the squarer box letterboxes it — the original bug on a
  // smaller screen.
  //
  // That gate is right for a default and wrong for an instruction. Six live
  // leaderboards had no mobile artwork at all and rendered about 38px tall on
  // a phone: proportionally correct, far too short to read. An admin setting a
  // mobile size for one slot is choosing the letterboxing deliberately, so
  // `mobileSet` separates the two cases and the public page honours it.
  const { resolveAdSlotSizes, validateFormats } = require('../src/utils/adSlotFormats');

  const untouched = resolveAdSlotSizes('{}')['news-leaderboard'];
  assert.equal(untouched.mobileSet, false, 'an inherited default is not an instruction');

  const chosen = resolveAdSlotSizes(JSON.stringify({
    'news-leaderboard': { mobileW: 300, mobileH: 250 },
  }))['news-leaderboard'];
  assert.equal(chosen.mobileSet, true);
  assert.deepEqual([chosen.mobileW, chosen.mobileH], [300, 250]);

  // Half a pair is not a choice, and is refused rather than half-applied.
  assert.ok(validateFormats({ 'news-leaderboard': { mobileW: 300 } }).error,
    'a mobile width with no height must be refused, not treated as chosen');
});

test('the public payload carries the distinction, and the page acts on it', async () => {
  await pool.query(`INSERT INTO ad_slots (slot_key, image_url, is_active)
                    VALUES ('about-leaderboard', 'https://a.test/ab.jpg', true)`);
  await api('PATCH', '/admin/settings/' + FORMATS_KEY,
    { value: JSON.stringify({ 'about-leaderboard': { mobileW: 300, mobileH: 250 } }) }, adminToken);

  const { body } = await api('GET', '/page-cms');
  const s = body.adSlotSizes['about-leaderboard'];
  assert.equal(s.mobileSet, true, 'the page cannot honour a choice it is not told about');
  assert.deepEqual([s.mobileW, s.mobileH], [300, 250]);

  // And the renderer must consult it, not only the artwork.
  const html = fs.readFileSync(path.join(siteRoot, 'unplug-magazine.html'), 'utf8');
  const gate = html.match(/if \(slotSize\.mobileW > 0[\s\S]{0,240}?\{/);
  assert.ok(gate, 'the mobile-ratio gate has moved — re-check it still honours mobileSet');
  assert.match(gate[0], /mobileSet\s*\|\|/,
    'an admin-set mobile size must bypass the every-banner-has-artwork requirement');
  assert.match(gate[0], /every\(\(b\) => b\.mobile_image_url\)/,
    'and the artwork check must remain for slots still on the default');

  await api('PATCH', '/admin/settings/' + FORMATS_KEY, { value: '{}' }, adminToken);
});

// ------------------------------------- uploads that never touch UnplugUpload
//
// Everything above guards fields rendered by UnplugUpload.fieldHtml. That
// missed an entire category: raw <input type="file"> controls on their own
// pages. An audit of every file input on the site found SIX accepting images
// with no stated size at all — the growth application gallery and its two
// upload fields, the agreement signature, and the company stamp — none of
// which any existing test could see, because none of them calls fieldHtml.
//
// This is the guard for that category. It is deliberately about the PAGE
// rather than the widget: wherever somebody can hand over an image, the page
// has to tell them what shape to bring.

const IMAGE_UPLOAD_PAGES = [
  'unplug-admin-dashboard.html',
  'unplug-member-dashboard.html',
  'unplug-growth-application.html',
  'unplug-growth-application-v2.html',
  'unplug-agreement.html',
];

test('EVERY PAGE WITH A RAW IMAGE UPLOAD ALSO STATES A SIZE', () => {
  // A page whose file input accepts images must resolve a size from the server
  // somewhere — specText/imgSpecFull/uploadSizes are the three ways it is done.
  // A page whose inputs are only PDFs or proof-of-payment needs nothing: a
  // receipt has no right shape, and a PDF has no pixel dimensions at all.
  const silent = [];
  IMAGE_UPLOAD_PAGES.forEach((f) => {
    const src = fs.readFileSync(path.join(siteRoot, f), 'utf8');
    const inputs = src.match(/<input[^>]*type="file"[^>]*>/g) || [];
    const acceptsImage = inputs.some((i) => /accept="[^"]*image\//.test(i));
    if (!acceptsImage) return;
    const statesASize = /specText\(|imgSpecFull\(|adSlotSpec\(|uploadSizes/.test(src);
    if (!statesASize) silent.push(f);
  });
  assert.deepEqual(silent, [],
    'these pages take an image upload and tell the person nothing about what shape to bring:\n  '
    + silent.join('\n  '));
});

test('the new sizes are real, and each says which way round it goes', async () => {
  const { body } = await api('GET', '/image-specs', null, memberToken);
  const added = ['growth_gallery_photo', 'growth_upload_landscape',
                 'growth_upload_portrait', 'signature_image', 'company_stamp'];
  added.forEach((k) => {
    const s = body.specs[k];
    assert.ok(s, k + ' is missing');
    assert.ok(Number.isInteger(s.w) && Number.isInteger(s.h), k + ' has no usable size');
    assert.match(s.text, /\d+ × \d+px/, k + ' has no readable sentence');
  });

  // Orientation is the point of the growth pair — if they ever stop being a
  // landscape/portrait flip of each other, offering a choice is meaningless.
  const l = body.specs.growth_upload_landscape;
  const p = body.specs.growth_upload_portrait;
  assert.ok(l.w > l.h, 'the landscape option must be landscape');
  assert.ok(p.h > p.w, 'the portrait option must be portrait');
  assert.deepEqual([l.w, l.h], [p.h, p.w], 'the pair should be the same numbers flipped');

  // A signature is always far wider than it is tall; a stamp is square.
  assert.ok(body.specs.signature_image.w > body.specs.signature_image.h * 2);
  assert.equal(body.specs.company_stamp.w, body.specs.company_stamp.h);
});

test('the signing page can state its sizes without an account', async () => {
  // unplug-agreement.html is opened from a signing link by someone who may have
  // no login at all, so it cannot call /image-specs — that stays behind
  // requireAuth. The sizes therefore travel with the form definition instead,
  // still sourced from IMAGE_SPECS rather than restated.
  const { IMAGE_SPECS, describe } = require('../src/utils/imageSpecs');
  const src = fs.readFileSync(path.join(siteRoot, 'unplug-backend', 'src', 'routes',
    'agreementForms.js'), 'utf8');
  assert.match(src, /uploadSizes:\s*\{/, 'the public form definition carries no upload sizes');
  assert.match(src, /describe\(IMAGE_SPECS\.signature_image\)/,
    'the signature size must come from IMAGE_SPECS, not be written out again here');
  assert.match(src, /describe\(IMAGE_SPECS\.company_stamp\)/);

  const page = fs.readFileSync(path.join(siteRoot, 'unplug-agreement.html'), 'utf8');
  assert.match(page, /uploadSizes/, 'the signing page never reads the sizes it is sent');
  // And it must not have quietly gained its own copy of a number.
  assert.doesNotMatch(page, /\b\d{3,4}\s*[x×]\s*\d{3,4}\s*px/i,
    'the signing page states a size of its own instead of using the one it is sent');
  assert.ok(describe(IMAGE_SPECS.company_stamp).length > 10);
});
