// Popups an admin composes themselves.
//
// A popup is the one thing on this site that appears over the page, unasked,
// in front of every reader — so the tests that matter most here are the ones
// about what CANNOT get into one.
//
// What these protect:
//
//   1. THE WHITELIST HOLDS. An unknown block type, an unknown field, a
//      javascript: URL, a video link to a host we do not embed — all dropped
//      rather than stored. Editing is checked as strictly as creating, because
//      an edit that skipped the cleaning would be a way straight past it.
//   2. EXISTING POPUPS STILL WORK. Every popup made before the builder has an
//      empty blocks list and must keep its original layout. This is the test
//      that stops a deploy blanking what is live.
//   3. CONTRAST IS REPORTED HONESTLY, using the WCAG arithmetic rather than a
//      guess, so an admin is told before readers are.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-popupbuild-'));
const port = 46800 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

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
  process.env.JWT_SECRET = 'test-secret-for-popupbuilder';
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
  app.use('/popups', require('../src/routes/popups'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (680001, 'pb@test.com', 'PB Admin', 'x', 'admin')`);
  adminToken = jwt.sign({ id: 680001, email: 'pb@test.com', role: 'admin' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

async function makePopup(extra) {
  const { body } = await api('POST', '/popups',
    Object.assign({ name: 'Test popup', title: 'Hello' }, extra || {}), adminToken);
  return body;
}

// ------------------------------------------------------------- the whitelist

test('AN UNKNOWN BLOCK TYPE IS DROPPED, NOT STORED', async () => {
  // The renderer would not know what to do with it, so the only question is
  // whether an unaccountable row sits in the database waiting for somebody to
  // add a branch that renders it.
  const p = await makePopup({
    blocks: [
      { type: 'heading', text: 'Kept' },
      { type: 'script', text: 'alert(1)' },
      { type: 'iframe', url: 'https://evil.example.com' },
      { type: 'html', text: '<img onerror=alert(1)>' },
    ],
  });
  assert.deepEqual(p.blocks.map((b) => b.type), ['heading']);
});

test('A BLOCK KEEPS ONLY THE FIELDS ITS TYPE HAS', async () => {
  // Anything extra travelling alongside a legitimate block is dropped too —
  // an onclick smuggled onto a heading is not stored just because the heading
  // itself is fine.
  const p = await makePopup({
    blocks: [{ type: 'heading', text: 'Hello', onclick: 'alert(1)', style: 'x', __proto__: {} }],
  });
  assert.deepEqual(Object.keys(p.blocks[0]).sort(), ['text', 'type']);
});

test('A javascript: DESTINATION IS REFUSED', async () => {
  const p = await makePopup({
    blocks: [
      { type: 'button', label: 'Click', url: 'javascript:alert(1)' },
      { type: 'image', url: 'javascript:alert(1)' },
      { type: 'image', url: 'data:text/html,<script>alert(1)</script>' },
      { type: 'button', label: 'Fine', url: 'https://unplugnews.com/x' },
    ],
  });
  assert.equal(p.blocks.length, 1, 'only the real https button survives');
  assert.equal(p.blocks[0].url, 'https://unplugnews.com/x');
});

test('VIDEO IS ONLY EVER A HOST WE EMBED', async () => {
  // The stored value is not the link the admin pasted — it is an embed address
  // this code built. That is what stops an arbitrary page being rendered
  // inside an iframe in a popup.
  const p = await makePopup({
    blocks: [
      { type: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      { type: 'video', url: 'https://evil.example.com/player' },
      { type: 'video', url: 'https://unplugnews.com/not-a-video' },
    ],
  });
  assert.equal(p.blocks.length, 1);
  assert.match(p.blocks[0].src, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ$/);
  assert.equal(p.blocks[0].url, undefined, 'the pasted link is not kept');
});

test('the embed is the no-tracking version of the player', async () => {
  // A popup fires before a reader has done anything. Loading a tracking frame
  // at that moment is not something we could honestly call their choice.
  const yt = await makePopup({ blocks: [{ type: 'video', url: 'https://youtu.be/abc123XYZ_-' }] });
  assert.match(yt.blocks[0].src, /youtube-nocookie\.com/);
  const vim = await makePopup({ blocks: [{ type: 'video', url: 'https://vimeo.com/123456789' }] });
  assert.match(vim.blocks[0].src, /dnt=1/);
});

test('a block that would render as nothing is not stored', async () => {
  // An empty heading is an invisible gap the admin cannot see in order to
  // delete it.
  const p = await makePopup({
    blocks: [
      { type: 'heading', text: '   ' },
      { type: 'button', label: 'No destination' },
      { type: 'button', url: 'https://unplugnews.com' },
      { type: 'image', url: '' },
      { type: 'text', text: 'Real words' },
    ],
  });
  assert.deepEqual(p.blocks.map((b) => b.type), ['text']);
});

test('EDITING IS CHECKED AS STRICTLY AS CREATING', async () => {
  // An edit path that skipped the cleaning would be a way straight past every
  // test above.
  const p = await makePopup({ blocks: [{ type: 'heading', text: 'Fine' }] });
  const { body } = await api('PATCH', '/popups/' + p.id, {
    blocks: [{ type: 'heading', text: 'Still fine' }, { type: 'script', text: 'alert(1)' },
      { type: 'button', label: 'x', url: 'javascript:alert(1)' }],
  }, adminToken);
  assert.deepEqual(body.blocks.map((b) => b.type), ['heading']);
});

test('a popup cannot be a whole page', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ type: 'text', text: 'line ' + i }));
  const p = await makePopup({ blocks: many });
  assert.ok(p.blocks.length <= 20, 'capped, got ' + p.blocks.length);
});

// ------------------------------------------------- existing popups keep working

test('A POPUP MADE BEFORE THE BUILDER IS UNTOUCHED', async () => {
  // This is the one that stops a deploy blanking what is live. No blocks means
  // the renderer draws the original layout from the original columns, and all
  // of them must still be there.
  const p = await makePopup({
    kind: 'announcement', title: 'Old style', body: 'Some words',
    buttonLabel: 'Go', buttonUrl: 'https://unplugnews.com',
  });
  assert.deepEqual(p.blocks, []);
  assert.equal(p.title, 'Old style');
  assert.equal(p.body, 'Some words');
  assert.equal(p.button_url, 'https://unplugnews.com');

  // And the public endpoint still sends everything the old renderer reads.
  const live = await api('PATCH', '/popups/' + p.id, { active: true }, adminToken);
  assert.equal(live.body.active, true);
  const { body } = await api('GET', '/popups/active');
  const mine = body.find((x) => x.id === p.id);
  ['title', 'body', 'button_label', 'button_url', 'image_url', 'kind', 'scroll_percent']
    .forEach((k) => assert.ok(k in mine, 'the public feed lost ' + k));
});

test('the public feed carries the builder fields too', async () => {
  const p = await makePopup({
    blocks: [{ type: 'heading', text: 'Composed' }],
    position: 'bottom-right', animation: 'zoom', autoCloseSeconds: 20,
  });
  await api('PATCH', '/popups/' + p.id, { active: true }, adminToken);
  const { body } = await api('GET', '/popups/active');
  const mine = body.find((x) => x.id === p.id);
  assert.equal(mine.position, 'bottom-right');
  assert.equal(mine.animation, 'zoom');
  assert.equal(mine.auto_close_seconds, 20);
  assert.equal(mine.blocks[0].text, 'Composed');
});

// --------------------------------------------------------- behaviour settings

test('a position or animation we do not have falls back rather than storing', async () => {
  const p = await makePopup({ position: 'floating-jellyfish', animation: 'explode' });
  assert.equal(p.position, 'center');
  assert.equal(p.animation, 'fade-up');
});

test('an auto-close of nothing means it waits for the reader', async () => {
  // Null is the meaningful answer here, not zero — zero seconds would mean a
  // popup that closes the instant it opens.
  const none = await makePopup({ autoCloseSeconds: '' });
  assert.equal(none.auto_close_seconds, null);
  const zero = await makePopup({ autoCloseSeconds: 0 });
  assert.equal(zero.auto_close_seconds, null);
  const capped = await makePopup({ autoCloseSeconds: 99999 });
  assert.equal(capped.auto_close_seconds, 300);
});

test('AUTOPLAY IS ALWAYS STORED AS MUTED-CAPABLE', async () => {
  // Browsers block autoplaying sound outright, so an unmuted autoplay would be
  // a setting that silently does nothing. The renderer always adds mute=1; this
  // records that the intent is autoplay, not autoplay-with-sound.
  const p = await makePopup({ media: { autoplay: true, loop: true, controls: false } });
  assert.equal(p.media.autoplay, true);
  assert.equal(p.media.loop, true);
  assert.equal(p.media.controls, false);
});

// ---------------------------------------------------------------- readability

test('CONTRAST IS REPORTED WITH THE REAL ARITHMETIC', async () => {
  const { contrastRatio } = require('../src/utils/popupBuilder');
  // Known values: black on white is 21:1, white on white is 1:1.
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
});

test('the builder is told when text would be unreadable, before it is live', async () => {
  const { status, body } = await api('POST', '/popups/preview', {
    blocks: [{ type: 'heading', text: 'Hi' }],
    style: { background: '#ffffff', titleColor: '#f2f2f2' },
  }, adminToken);
  assert.equal(status, 200);
  const heading = body.contrast.find((c) => c.what === 'Heading');
  assert.equal(heading.passes, false);
  assert.match(heading.message, /below the 4.5:1/);
});

test('the preview says how many pieces were dropped', async () => {
  // A silently shorter list looks like the editor lost the work.
  const { body } = await api('POST', '/popups/preview', {
    blocks: [{ type: 'heading', text: 'Kept' }, { type: 'script' }, { type: 'button', label: 'x' }],
  }, adminToken);
  assert.equal(body.blocks.length, 1);
  assert.equal(body.dropped, 2);
});

test('the preview stores nothing', async () => {
  const before = await api('GET', '/popups', null, adminToken);
  await api('POST', '/popups/preview', { blocks: [{ type: 'heading', text: 'x' }] }, adminToken);
  const after = await api('GET', '/popups', null, adminToken);
  assert.equal(after.body.length, before.body.length);
});

// --------------------------------------------------------------------- access

test('THE BUILDER IS ADMIN-ONLY', async () => {
  assert.equal((await api('GET', '/popups/options')).status, 401);
  assert.equal((await api('POST', '/popups/preview', { blocks: [] })).status, 401);
});

test('the block types the builder offers are the ones the server accepts', async () => {
  // Two lists in two files drift, and the one that matters is the one that
  // decides what is stored.
  const { body } = await api('GET', '/popups/options', null, adminToken);
  const { BLOCK_TYPES } = require('../src/utils/popupBuilder');
  assert.deepEqual(body.blockTypes.slice().sort(), BLOCK_TYPES.slice().sort());
  assert.ok(body.blockTypes.includes('transcript'),
    'a written version must be offerable, or media popups exclude Deaf readers');
});
