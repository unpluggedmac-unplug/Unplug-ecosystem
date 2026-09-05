// Let an admin actually SEE the picture before approving a submission, not
// just its URL as a string — requested directly, from the Approval Queue's
// review modal (the same one approvalQueueEdit.test.js covers).
//
// Every submission type with a real image-URL field (banner_image_url,
// feature_image_url, image_url, manual_image_url, poster_image_url,
// admin_image_url, mobile_image_url) now types it 'image' in DETAILS
// (adminApprovalQueue.js) instead of 'url' -- the frontend's field
// renderer only draws a preview <img> for that exact type. Genuine LINK
// fields (cta_url, contact_website, link_url, event_link,
// nominee_social_url) are deliberately left as 'url': they point
// somewhere else on the web, not at a picture, and rendering an <img> for
// one would just show a broken-image icon.
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
let adminToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-aqimgprev-'));
const port = 45200 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
async function runMigrations() {
  for (const f of fs.readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
}

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function fieldType(fields, col) {
  const f = fields.find((x) => x.col === col);
  return f ? f.type : undefined;
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
  process.env.JWT_SECRET = 'test-secret-for-aqimgprev';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin/approval-queue', require('../src/routes/adminApprovalQueue'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role) VALUES
    (610001, 'aqimg-admin@test.com', 'AQ Img Admin', 'x', 'admin'),
    (610002, 'aqimg-member@test.com', 'AQ Img Member', 'x', 'member')`);
  adminToken = jwt.sign({ id: 610001, email: 'aqimg-admin@test.com', role: 'admin' }, process.env.JWT_SECRET);

  await pool.query(`INSERT INTO categories (id, name, type) VALUES (9501, 'News', 'news')
                    ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO articles (id, author_user_id, category_id, title, body, cta_url, banner_image_url, status)
     VALUES (9502, 610002, 9501, 'Pending Story', 'Body', 'https://example.com/join', 'https://example.com/cover.jpg', 'pending')`
  );
  await pool.query(
    `INSERT INTO gallery_images (id, owner_type, title, caption, link_url, image_url, status)
     VALUES (9503, 'general', 'A photo', 'It''s always a good time for a selfie bender', 'https://example.com/more', 'https://example.com/selfie.jpg', 'pending')`
  );
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('AN ARTICLE\'S COVER IMAGE IS TYPED "image", ITS BUTTON LINK STAYS "url"', async () => {
  const { status, body } = await api('GET', '/admin/approval-queue/article/9502', null, adminToken);
  assert.equal(status, 200);
  assert.equal(fieldType(body.fields, 'banner_image_url'), 'image');
  assert.equal(fieldType(body.fields, 'cta_url'), 'url', 'a button link is not a picture');
  assert.equal(body.item.banner_image_url, 'https://example.com/cover.jpg', 'the real value is still there for the preview to use');
});

test('A GALLERY SUBMISSION\'S PICTURE IS TYPED "image", ITS "FIND OUT MORE" LINK STAYS "url"', async () => {
  const { body } = await api('GET', '/admin/approval-queue/gallery/9503', null, adminToken);
  assert.equal(fieldType(body.fields, 'image_url'), 'image');
  assert.equal(fieldType(body.fields, 'link_url'), 'url', 'this one points elsewhere on the web, not at a picture');
});

test('EVERY IMAGE-SHAPED FIELD ACROSS EVERY SUBMISSION TYPE IS "image", NOT "url"', () => {
  // Reads the route's own field table directly, rather than hitting every
  // type over HTTP with fixture rows — this is a completeness check across
  // all ~9 image columns, not a behavioural one (that's covered above).
  delete require.cache[require.resolve('../src/routes/adminApprovalQueue')];
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminApprovalQueue.js'), 'utf8');
  const imageLikeCols = [...src.matchAll(/f\('(\w*image\w*)',\s*'[^']*',\s*'(\w+)'\)/g)];
  assert.ok(imageLikeCols.length >= 9, `expected at least 9 image-named fields, found ${imageLikeCols.length}`);
  const wrong = imageLikeCols.filter(([, , type]) => type !== 'image');
  assert.deepEqual(wrong, [], `every column with "image" in its name must be typed 'image': ${wrong.map((w) => w[1]).join(', ')}`);
});

test('NO GENUINE LINK FIELD WAS ACCIDENTALLY SWEPT INTO "image"', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminApprovalQueue.js'), 'utf8');
  for (const col of ['cta_url', 'contact_website', 'link_url', 'event_link', 'nominee_social_url']) {
    const m = src.match(new RegExp(`f\\('${col}',\\s*'[^']*',\\s*'(\\w+)'\\)`, 'g'));
    assert.ok(m && m.length, `${col} should still be declared`);
    m.forEach((decl) => assert.match(decl, /'url'\)$/, `${decl} — a link field must stay 'url', not become 'image'`));
  }
});

test('THE ADMIN DASHBOARD RENDERS A REAL <img> PREVIEW FOR AN "image" FIELD, ESCAPED AND HIDDEN ON A BROKEN LINK', () => {
  const dashPath = path.join(__dirname, '..', '..', 'unplug-admin-dashboard.html');
  const html = fs.readFileSync(dashPath, 'utf8');
  const idx = html.indexOf("if (f.type === 'image')");
  assert.ok(idx > -1, 'the review-modal field renderer must special-case the image type');
  const body = html.slice(idx, idx + 1000);
  assert.match(body, /<img /, 'must actually draw a picture, not just describe the URL');
  assert.match(body, /escapeAttrAdmin\(val\)/, 'the URL must be escaped before going into src="…"');
  assert.match(body, /onerror="this\.style\.display='none';"/, 'a broken/removed URL must not show a broken-image icon');
  assert.match(body, /const preview = val\s*\n\s*\?[\s\S]*?:\s*'';/, 'no preview at all — not even a broken one — when the field is blank');
  // The editable URL text input must still exist alongside the preview, so
  // an admin can still correct/replace it exactly as before this feature.
  assert.match(body, /type="url"/);
});
