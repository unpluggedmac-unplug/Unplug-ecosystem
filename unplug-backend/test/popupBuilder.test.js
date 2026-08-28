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

// --------------------------------------------------------------- creating

test('A POPUP IS CREATED COMPLETE, IN ONE REQUEST', async () => {
  // The admin screen used to ask for the name and heading in two browser
  // prompt() boxes, create an empty popup, and only then let anything be built
  // on it. So a popup existed half-made, and abandoning the editor left a
  // pointless row behind.
  //
  // Everything is now sent together, which means this create path has to
  // accept the whole thing — not just a name and a title.
  const { status, body } = await api('POST', '/popups', {
    name: 'October competition',
    title: 'Win a weekend away',
    blocks: [{ type: 'text', text: 'Two nights, all in.' },
      { type: 'button', label: 'Enter', url: '/nominate' }],
    style: { font: 'display', width: 'large', buttonBg: '#0a7d3c' },
    position: 'bottom-right', animation: 'zoom',
    triggerType: 'delay', triggerSeconds: 15, autoCloseSeconds: 30,
    media: { autoplay: true },
  }, adminToken);

  assert.equal(status, 201);
  assert.equal(body.name, 'October competition');
  assert.deepEqual(body.blocks.map((b) => b.type), ['text', 'button']);
  assert.equal(body.style.font, 'display');
  assert.equal(body.position, 'bottom-right');
  assert.equal(body.animation, 'zoom');
  assert.equal(body.trigger_type, 'delay');
  assert.equal(body.trigger_seconds, 15);
  assert.equal(body.auto_close_seconds, 30);
  assert.equal(body.media.autoplay, true);
});

test('a new popup is created switched OFF', async () => {
  // Nothing an admin makes should start interrupting readers because it was
  // saved. Switching it on is a separate, deliberate act.
  const { body } = await api('POST', '/popups',
    { name: 'Not yet', title: 'Hello', blocks: [{ type: 'text', text: 'x' }] }, adminToken);
  assert.equal(body.active, false);
});

test('creating still refuses a popup with no name or no heading', async () => {
  assert.equal((await api('POST', '/popups', { title: 'No name' }, adminToken)).status, 400);
  assert.equal((await api('POST', '/popups', { name: 'No heading' }, adminToken)).status, 400);
});

test('the whitelist applies on the way in, not only on edit', async () => {
  const { body } = await api('POST', '/popups', {
    name: 'Hostile', title: 'Hello',
    blocks: [{ type: 'script', text: 'alert(1)' },
      { type: 'button', label: 'x', url: 'javascript:alert(1)' },
      { type: 'text', text: 'kept' }],
  }, adminToken);
  assert.deepEqual(body.blocks.map((b) => b.type), ['text']);
});

// ------------------------------------------------------- what it is for

test('WHAT IT IS FOR IS THE ADMIN\'S OWN WORDS', async () => {
  // It used to be one of three fixed values, held down by a CHECK constraint:
  // newsletter, announcement, nominate. A community magazine announces more
  // kinds of thing than three, and the cost of the wrong list is somebody
  // filing a popup under a heading that does not describe it.
  const p = await makePopup({ purpose: 'Heritage Day competition' });
  assert.equal(p.purpose, 'Heritage Day competition');
});

test('a purpose is tidied, not rejected', async () => {
  // Free text still gets the obvious tidying, so trailing spaces and double
  // spaces do not turn one purpose into two.
  const p = await makePopup({ purpose: '  Community   Awards  ' });
  assert.equal(p.purpose, 'Community Awards');
  const empty = await makePopup({ purpose: '   ' });
  assert.equal(empty.purpose, null, 'blank is no purpose, not an empty string');
});

test('the builder is told which purposes are already in use', async () => {
  // This is the whole mitigation for free text: "Competition", "competition"
  // and "Comp" become three different things only if nobody is shown what
  // already exists.
  await makePopup({ purpose: 'Winter drive' });
  const { body } = await api('GET', '/popups/options', null, adminToken);
  assert.ok(Array.isArray(body.purposes));
  assert.ok(body.purposes.includes('Winter drive'));
});

test('the purpose can be changed later', async () => {
  const p = await makePopup({ purpose: 'Draft name' });
  const { body } = await api('PATCH', '/popups/' + p.id, { purpose: 'Better name' }, adminToken);
  assert.equal(body.purpose, 'Better name');
});

test('THE OLD FIXED TYPE IS UNTOUCHED', async () => {
  // `kind` still decides the layout of every popup made before the builder.
  // Repurposing or dropping it would change how those render, which is a thing
  // that would only be discovered on the live site.
  const p = await makePopup({ kind: 'newsletter', purpose: 'Anything I like' });
  assert.equal(p.kind, 'newsletter');
  assert.equal(p.purpose, 'Anything I like');
  // And it still refuses a value it does not know, rather than storing it.
  const odd = await makePopup({ kind: 'not-a-kind' });
  assert.equal(odd.kind, 'newsletter', 'falls back rather than breaking the constraint');
});

// ------------------------------------------------------------- starters

test('every starting point is made of blocks that survive saving', async () => {
  // A starter that offered a block the whitelist then dropped would put an
  // admin in front of a piece that vanishes when they save it.
  const { body } = await api('GET', '/popups/options', null, adminToken);
  assert.ok(body.starters.length >= 6);
  const { BLOCK_TYPES } = require('../src/utils/popupBuilder');
  body.starters.forEach((st) => {
    assert.ok(st.key && st.label, 'a starter needs a name');
    assert.ok(st.blocks.length, st.key + ' starts with nothing');
    st.blocks.forEach((b) => {
      assert.ok(BLOCK_TYPES.includes(b.type), `${st.key} offers an unknown block: ${b.type}`);
    });
  });
});

test('A STARTER ARRIVES EMPTY, so no placeholder can go live', async () => {
  // Wording that came pre-filled would end up in front of readers with the
  // placeholder still on it.
  const { body } = await api('GET', '/popups/options', null, adminToken);
  body.starters.forEach((st) => {
    st.blocks.forEach((b) => {
      if (b.type === 'heading' || b.type === 'text' || b.type === 'transcript') {
        assert.equal(b.text, '', `${st.key} ships wording in a ${b.type}`);
      }
    });
  });
});

test('a video starting point brings its written version with it', async () => {
  // Not something to remember afterwards. A popup that only speaks excludes
  // every Deaf reader, on a magazine that exists partly for them.
  const { body } = await api('GET', '/popups/options', null, adminToken);
  const video = body.starters.find((x) => x.key === 'video');
  assert.ok(video, 'there is a video starting point');
  assert.ok(video.blocks.some((b) => b.type === 'transcript'),
    'a video starter with no written version is the thing this magazine should not ship');
});

test('starters are admin-only, like everything else in the builder', async () => {
  assert.equal((await api('GET', '/popups/options')).status, 401);
});
