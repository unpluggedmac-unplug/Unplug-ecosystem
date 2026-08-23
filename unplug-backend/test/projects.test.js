// Investor project showcases, tested against a REAL PostgreSQL.
//
// These pages carry sponsor logos and links, so the failures that matter are
// about what reaches the public site and what a link can be made to do:
//
//   1. a draft project must not be readable by anyone who guesses its id — a
//      showcase is written and revised before the investor has approved it;
//   2. the homepage Investor Spotlight must never render a broken card. It
//      points at a project by id, so unpublishing or deleting that project has
//      to take the spotlight down rather than leave a dead link;
//   3. video and sponsor links are rebuilt from a URL the server recognises,
//      never taken as given — an admin pasting embed HTML or a javascript: URL
//      would be executing it on every visitor's page;
//   4. the 20-image cap and the 450-word cap are enforced by the server, not
//      just counted in the browser;
//   5. exactly one image is the cover.
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
let jwt;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-projects-'));
const port = 32000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `pj${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 551000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `pj${id}@test.com`, role]
  );
  return id;
}

// Create a project through the API, so the tests exercise the same path the
// admin screen uses rather than a shortcut into the table.
async function makeProject(title, { publish = true } = {}) {
  const created = await req('POST', '/projects/admin', {
    token: adminToken, body: { title, description: 'A short description.' },
  });
  assert.equal(created.status, 201, `could not create project "${title}"`);
  const id = created.body.project.id;
  if (publish) {
    const pub = await req('PATCH', `/projects/admin/${id}`, {
      token: adminToken, body: { status: 'published' },
    });
    assert.equal(pub.status, 200);
  }
  return id;
}

let adminId;
let adminToken;
let memberToken;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-projects';
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
  app.use('/projects', require('../src/routes/projects'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminId = await makeUser('admin');
  adminToken = tokenFor(adminId, 'admin');
  memberToken = tokenFor(await makeUser());
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
// Unpublished work stays private
// ---------------------------------------------------------------------------

test('A DRAFT PROJECT IS NOT READABLE BY GUESSING ITS ID', async () => {
  // Showcases are drafted and revised before the investor signs them off.
  const id = await makeProject('Unfinished Draft', { publish: false });

  const listed = await req('GET', '/projects');
  assert.ok(!listed.body.projects.some((p) => p.id === id), 'not in the public list');

  const direct = await req('GET', `/projects/${id}`);
  assert.equal(direct.status, 404, 'and not reachable directly either');
});

test('unpublishing takes a project back off the site', async () => {
  const id = await makeProject('Was Live');
  assert.equal((await req('GET', `/projects/${id}`)).status, 200);

  await req('PATCH', `/projects/admin/${id}`, { token: adminToken, body: { status: 'unpublished' } });
  assert.equal((await req('GET', `/projects/${id}`)).status, 404,
    'the take-down is immediate');
});

test('an admin can read any project at any status', async () => {
  const id = await makeProject('Admin Only View', { publish: false });
  const seen = await req('GET', `/projects/admin/${id}`, { token: adminToken });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.project.status, 'draft');
});

test('a non-numeric project id is a clean 400, not a crash', async () => {
  const bad = await req('GET', '/projects/not-a-number');
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------------------
// The homepage spotlight must never show a broken card
// ---------------------------------------------------------------------------

test('THE SPOTLIGHT CANNOT BE POINTED AT AN UNPUBLISHED PROJECT', async () => {
  const id = await makeProject('Not Ready Yet', { publish: false });
  const refused = await req('PUT', '/projects/admin/spotlight', {
    token: adminToken, body: { projectId: id, note: 'Look at this', active: true },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /publish/i, 'and the message says what to do about it');
});

test('the spotlight can be saved as inactive against an unpublished project', async () => {
  // Setting it up before publishing is a reasonable thing to want to do.
  const id = await makeProject('Prepared Early', { publish: false });
  const saved = await req('PUT', '/projects/admin/spotlight', {
    token: adminToken, body: { projectId: id, note: 'Ready when it is', active: false },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.active, false);

  const publicView = await req('GET', '/projects/spotlight');
  assert.equal(publicView.body.active, false, 'and nothing shows on the homepage');
});

test('a live spotlight shows the project and the note', async () => {
  const id = await makeProject('Flagship Project');
  await req('PUT', '/projects/admin/spotlight', {
    token: adminToken, body: { projectId: id, note: 'Our biggest build yet', active: true },
  });

  const publicView = await req('GET', '/projects/spotlight');
  assert.equal(publicView.body.active, true);
  assert.equal(publicView.body.project.id, id);
  assert.equal(publicView.body.note, 'Our biggest build yet');
});

test('UNPUBLISHING THE SPOTLIT PROJECT HIDES THE SECTION RATHER THAN BREAKING IT', async () => {
  const id = await makeProject('Spotlit Then Pulled');
  await req('PUT', '/projects/admin/spotlight', {
    token: adminToken, body: { projectId: id, note: 'n', active: true },
  });
  assert.equal((await req('GET', '/projects/spotlight')).body.active, true);

  await req('PATCH', `/projects/admin/${id}`, { token: adminToken, body: { status: 'unpublished' } });

  const after = await req('GET', '/projects/spotlight');
  assert.equal(after.body.active, false,
    'the homepage hides the whole section instead of rendering a card that 404s');
});

test('deleting the spotlit project clears the spotlight, leaving no dangling id', async () => {
  const id = await makeProject('Spotlit Then Deleted');
  await req('PUT', '/projects/admin/spotlight', {
    token: adminToken, body: { projectId: id, note: 'n', active: true },
  });

  const gone = await req('DELETE', `/projects/admin/${id}`, { token: adminToken });
  assert.equal(gone.status, 200);

  const cfg = await req('GET', '/projects/admin/spotlight', { token: adminToken });
  assert.equal(cfg.body.projectId, null, 'the admin screen does not offer a project that no longer exists');
  assert.equal((await req('GET', '/projects/spotlight')).body.active, false);
});

test('the spotlight is a single slot — choosing a new project replaces the old', async () => {
  const first = await makeProject('First Choice');
  const second = await makeProject('Second Choice');
  await req('PUT', '/projects/admin/spotlight', {
    token: adminToken, body: { projectId: first, active: true },
  });
  await req('PUT', '/projects/admin/spotlight', {
    token: adminToken, body: { projectId: second, active: true },
  });

  const live = await req('GET', '/projects/spotlight');
  assert.equal(live.body.project.id, second, 'there is only ever one spotlight');
});

test('the spotlight refuses a project that does not exist', async () => {
  const bad = await req('PUT', '/projects/admin/spotlight', {
    token: adminToken, body: { projectId: 99999999, active: true },
  });
  assert.equal(bad.status, 404);
});

test('/admin/spotlight is not swallowed by /admin/:id', async () => {
  // Both are two-segment admin routes. If /admin/:id were registered first,
  // Express would read "spotlight" as an id and this would 404 — the route
  // order in the file is load-bearing, so it is worth a test rather than
  // only a comment.
  const cfg = await req('GET', '/projects/admin/spotlight', { token: adminToken });
  assert.equal(cfg.status, 200);
  assert.ok('active' in cfg.body, 'it returned the spotlight config, not a project');
});

// ---------------------------------------------------------------------------
// Links and embeds are rebuilt, never trusted
// ---------------------------------------------------------------------------

test('A YOUTUBE LINK IS REBUILT INTO AN EMBED URL WE CONSTRUCT', async () => {
  const id = await makeProject('With Video');
  const saved = await req('PATCH', `/projects/admin/${id}`, {
    token: adminToken,
    body: { videoPlatform: 'youtube', videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42' },
  });
  assert.equal(saved.status, 200);
  // youtube-nocookie is YouTube's own privacy-preserving host, and projects
  // now share the article video parser rather than keeping a second copy that
  // understood only YouTube and Instagram.
  assert.equal(saved.body.project.video_embed_url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    'the embed URL is built from the id we extracted, not from what was pasted');
});

test('the short youtu.be form works too', async () => {
  const id = await makeProject('Short Link Video');
  const saved = await req('PATCH', `/projects/admin/${id}`, {
    token: adminToken, body: { videoPlatform: 'youtube', videoUrl: 'https://youtu.be/abc123XYZ' },
  });
  assert.equal(saved.body.project.video_embed_url, 'https://www.youtube-nocookie.com/embed/abc123XYZ');
});

test('embed HTML pasted into the video field is refused', async () => {
  // An admin copying "embed code" off YouTube is the obvious mistake, and
  // storing raw HTML would put whatever it contains on the public page.
  const id = await makeProject('Pasted Embed');
  const bad = await req('PATCH', `/projects/admin/${id}`, {
    token: adminToken,
    body: { videoPlatform: 'youtube', videoUrl: '<iframe src="https://evil.example/x"></iframe>' },
  });
  assert.equal(bad.status, 400);
  // The shared parser names the actual mistake instead of saying "invalid",
  // because someone who pasted embed code will otherwise paste it again.
  assert.match(bad.body.error, /embed code/i);
});

test('a non-Instagram link is refused for the Instagram platform', async () => {
  const id = await makeProject('Wrong Platform');
  const bad = await req('PATCH', `/projects/admin/${id}`, {
    token: adminToken,
    body: { videoPlatform: 'instagram', videoUrl: 'https://example.com/reel/123' },
  });
  assert.equal(bad.status, 400);
});

test('a real Instagram reel link is normalised', async () => {
  const id = await makeProject('Instagram Reel');
  const saved = await req('PATCH', `/projects/admin/${id}`, {
    token: adminToken,
    body: { videoPlatform: 'instagram', videoUrl: 'https://www.instagram.com/reel/Cxyz123/?igshid=tracking' },
  });
  assert.equal(saved.status, 200);
  assert.ok(!saved.body.project.video_embed_url.includes('igshid'),
    'the tracking query is stripped rather than embedded on our page');
});

test('the video can be removed again', async () => {
  const id = await makeProject('Video Removed');
  await req('PATCH', `/projects/admin/${id}`, {
    token: adminToken, body: { videoPlatform: 'youtube', videoUrl: 'https://youtu.be/abc123XYZ' },
  });
  const cleared = await req('PATCH', `/projects/admin/${id}`, {
    token: adminToken, body: { videoPlatform: 'none' },
  });
  assert.equal(cleared.body.project.video_platform, null);
  assert.equal(cleared.body.project.video_embed_url, null);
});

test('A SPONSOR LINK MUST BE HTTPS — javascript: IS REFUSED', async () => {
  const id = await makeProject('Sponsor Link Safety');
  const bad = await req('POST', `/projects/admin/${id}/sponsors`, {
    token: adminToken, body: { name: 'Dodgy Co', linkType: 'website', linkUrl: 'javascript:alert(1)' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /https/i);
});

test('plain http is refused for a sponsor link', async () => {
  const id = await makeProject('Sponsor Http');
  const bad = await req('POST', `/projects/admin/${id}/sponsors`, {
    token: adminToken, body: { name: 'Old Site', linkUrl: 'http://example.com' },
  });
  assert.equal(bad.status, 400);
});

test('a Facebook sponsor link must actually point at Facebook', async () => {
  const id = await makeProject('Sponsor Facebook');
  const bad = await req('POST', `/projects/admin/${id}/sponsors`, {
    token: adminToken,
    body: { name: 'Not Facebook', linkType: 'facebook', linkUrl: 'https://facebook.evil.example/page' },
  });
  assert.equal(bad.status, 400,
    'a link labelled Facebook that goes elsewhere is how a reader gets phished');
});

test('a sponsor with no link at all is fine', async () => {
  const id = await makeProject('Sponsor No Link');
  const ok = await req('POST', `/projects/admin/${id}/sponsors`, {
    token: adminToken, body: { name: 'Quiet Sponsor' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.sponsor.link_url, null);
});

test('a sponsor needs a name', async () => {
  const id = await makeProject('Sponsor No Name');
  const bad = await req('POST', `/projects/admin/${id}/sponsors`, {
    token: adminToken, body: { name: '   ' },
  });
  assert.equal(bad.status, 400);
});

test('an inactive sponsor is hidden publicly but still visible to the admin', async () => {
  // Sponsors come and go; switching one off must not lose its record.
  const id = await makeProject('Sponsor Visibility');
  await req('POST', `/projects/admin/${id}/sponsors`, {
    token: adminToken, body: { name: 'Current Sponsor' },
  });
  const retired = await req('POST', `/projects/admin/${id}/sponsors`, {
    token: adminToken, body: { name: 'Retired Sponsor', isActive: false },
  });

  const publicView = await req('GET', `/projects/${id}`);
  assert.ok(!publicView.body.sponsors.some((s) => s.id === retired.body.sponsor.id),
    'a retired sponsor is not shown on the live page');

  const adminView = await req('GET', `/projects/admin/${id}`, { token: adminToken });
  assert.ok(adminView.body.sponsors.some((s) => s.id === retired.body.sponsor.id),
    'but the admin can still see and re-enable it');
});

// ---------------------------------------------------------------------------
// Limits the server enforces itself
// ---------------------------------------------------------------------------

test('THE 20-IMAGE CAP IS ENFORCED BY THE SERVER', async () => {
  const limits = await req('GET', '/projects/limits');
  const max = limits.body.maxImages;
  const id = await makeProject('Image Cap');

  for (let i = 0; i < max; i++) {
    const added = await req('POST', `/projects/admin/${id}/images`, {
      token: adminToken, body: { imageUrl: `https://example.com/${i}.jpg` },
    });
    assert.equal(added.status, 201, `image ${i + 1} should be accepted`);
  }

  const overflow = await req('POST', `/projects/admin/${id}/images`, {
    token: adminToken, body: { imageUrl: 'https://example.com/too-many.jpg' },
  });
  assert.equal(overflow.status, 400, 'the browser counter is not the only thing stopping this');
  assert.match(overflow.body.error, new RegExp(String(max)));
});

test('the limits endpoint is the one source both sides read', async () => {
  const limits = await req('GET', '/projects/limits');
  assert.equal(limits.status, 200);
  assert.ok(limits.body.maxDescriptionWords > 0);
  assert.ok(limits.body.maxImages > 0);
});

test('a description over the word limit is refused', async () => {
  const limits = await req('GET', '/projects/limits');
  const tooLong = Array.from({ length: limits.body.maxDescriptionWords + 5 }, () => 'word').join(' ');

  const bad = await req('POST', '/projects/admin', {
    token: adminToken, body: { title: 'Too Wordy', description: tooLong },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /too long/i);
});

test('an over-length description cannot sneak through by publishing later', async () => {
  // The create and update paths both check, but publishing re-checks against
  // what is actually stored — otherwise a description grown past the limit by
  // some other route would go live anyway.
  const id = await makeProject('Grown Too Long', { publish: false });
  const limits = await req('GET', '/projects/limits');
  const tooLong = Array.from({ length: limits.body.maxDescriptionWords + 5 }, () => 'word').join(' ');
  await pool.query('UPDATE projects SET description = $1 WHERE id = $2', [tooLong, id]);

  const refused = await req('PATCH', `/projects/admin/${id}`, {
    token: adminToken, body: { status: 'published' },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /shorten/i);
});

test('a project needs a title', async () => {
  const bad = await req('POST', '/projects/admin', { token: adminToken, body: { title: '  ' } });
  assert.equal(bad.status, 400);
});

test('a title cannot be emptied by an edit', async () => {
  const id = await makeProject('Has A Title');
  const bad = await req('PATCH', `/projects/admin/${id}`, { token: adminToken, body: { title: '' } });
  assert.equal(bad.status, 400);
});

test('an invalid status is refused', async () => {
  const id = await makeProject('Status Check');
  const bad = await req('PATCH', `/projects/admin/${id}`, { token: adminToken, body: { status: 'live-ish' } });
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------------------
// The gallery
// ---------------------------------------------------------------------------

test('EXACTLY ONE IMAGE IS THE COVER', async () => {
  const id = await makeProject('Cover Handling');
  const a = await req('POST', `/projects/admin/${id}/images`, {
    token: adminToken, body: { imageUrl: 'https://example.com/a.jpg' },
  });
  const b = await req('POST', `/projects/admin/${id}/images`, {
    token: adminToken, body: { imageUrl: 'https://example.com/b.jpg' },
  });

  await req('PATCH', `/projects/admin/images/${a.body.image.id}`, {
    token: adminToken, body: { isCover: true },
  });
  await req('PATCH', `/projects/admin/images/${b.body.image.id}`, {
    token: adminToken, body: { isCover: true },
  });

  const covers = await pool.query(
    'SELECT COUNT(*) AS n FROM project_images WHERE project_id = $1 AND is_cover', [id]);
  assert.equal(Number(covers.rows[0].n), 1, 'setting a new cover clears the old one');

  const view = await req('GET', `/projects/${id}`);
  assert.equal(view.body.coverImageUrl, 'https://example.com/b.jpg');
});

test('with no cover chosen, the first image is used', async () => {
  const id = await makeProject('Implicit Cover');
  await req('POST', `/projects/admin/${id}/images`, {
    token: adminToken, body: { imageUrl: 'https://example.com/first.jpg' },
  });
  await req('POST', `/projects/admin/${id}/images`, {
    token: adminToken, body: { imageUrl: 'https://example.com/second.jpg' },
  });

  const view = await req('GET', `/projects/${id}`);
  assert.equal(view.body.coverImageUrl, 'https://example.com/first.jpg',
    'a project always has a cover image, so the listing never shows a blank card');
});

test('an image needs a URL', async () => {
  const id = await makeProject('No Image Url');
  const bad = await req('POST', `/projects/admin/${id}/images`, { token: adminToken, body: {} });
  assert.equal(bad.status, 400);
});

test('REORDERING ONE PROJECT’S GALLERY CANNOT TOUCH ANOTHER’S', async () => {
  // The reorder takes a list of image ids. Without the project_id guard in the
  // UPDATE, a stale or crafted list would renumber images on a different
  // project entirely.
  const mine = await makeProject('My Gallery');
  const theirs = await makeProject('Their Gallery');

  const a = await req('POST', `/projects/admin/${mine}/images`, {
    token: adminToken, body: { imageUrl: 'https://example.com/mine-1.jpg' },
  });
  const victim = await req('POST', `/projects/admin/${theirs}/images`, {
    token: adminToken, body: { imageUrl: 'https://example.com/theirs-1.jpg' },
  });
  const before = await pool.query('SELECT display_order FROM project_images WHERE id = $1', [victim.body.image.id]);

  await req('POST', `/projects/admin/${mine}/reorder-images`, {
    token: adminToken, body: { order: [victim.body.image.id, a.body.image.id] },
  });

  const after = await pool.query('SELECT display_order FROM project_images WHERE id = $1', [victim.body.image.id]);
  assert.equal(after.rows[0].display_order, before.rows[0].display_order,
    'an image belonging to another project is left alone');
});

test('reordering puts the gallery in the order given', async () => {
  const id = await makeProject('Ordered Gallery');
  const first = await req('POST', `/projects/admin/${id}/images`, {
    token: adminToken, body: { imageUrl: 'https://example.com/one.jpg' },
  });
  const second = await req('POST', `/projects/admin/${id}/images`, {
    token: adminToken, body: { imageUrl: 'https://example.com/two.jpg' },
  });

  await req('POST', `/projects/admin/${id}/reorder-images`, {
    token: adminToken, body: { order: [second.body.image.id, first.body.image.id] },
  });

  const view = await req('GET', `/projects/${id}`);
  assert.equal(view.body.images[0].id, second.body.image.id);
  assert.equal(view.body.images[1].id, first.body.image.id);
});

test('deleting a project takes its sponsors and images with it', async () => {
  const id = await makeProject('Cascade Check');
  await req('POST', `/projects/admin/${id}/sponsors`, { token: adminToken, body: { name: 'S' } });
  await req('POST', `/projects/admin/${id}/images`, {
    token: adminToken, body: { imageUrl: 'https://example.com/x.jpg' },
  });

  await req('DELETE', `/projects/admin/${id}`, { token: adminToken });

  const sponsors = await pool.query('SELECT COUNT(*) AS n FROM project_sponsors WHERE project_id = $1', [id]);
  const images = await pool.query('SELECT COUNT(*) AS n FROM project_images WHERE project_id = $1', [id]);
  assert.equal(Number(sponsors.rows[0].n), 0, 'no orphaned sponsor rows');
  assert.equal(Number(images.rows[0].n), 0, 'no orphaned image rows');
});

test('deleting something that is already gone is a clean 404', async () => {
  const id = await makeProject('Delete Twice');
  assert.equal((await req('DELETE', `/projects/admin/${id}`, { token: adminToken })).status, 200);
  assert.equal((await req('DELETE', `/projects/admin/${id}`, { token: adminToken })).status, 404);
});

// ---------------------------------------------------------------------------
// Who can do what
// ---------------------------------------------------------------------------

test('every admin endpoint refuses a member and a stranger', async () => {
  const id = await makeProject('Auth Check');
  const cases = [
    ['GET', '/projects/admin/all'],
    ['GET', '/projects/admin/spotlight'],
    ['PUT', '/projects/admin/spotlight'],
    ['GET', `/projects/admin/${id}`],
    ['POST', '/projects/admin'],
    ['PATCH', `/projects/admin/${id}`],
    ['DELETE', `/projects/admin/${id}`],
    ['POST', `/projects/admin/${id}/sponsors`],
    ['PATCH', '/projects/admin/sponsors/1'],
    ['DELETE', '/projects/admin/sponsors/1'],
    ['POST', `/projects/admin/${id}/images`],
    ['PATCH', '/projects/admin/images/1'],
    ['DELETE', '/projects/admin/images/1'],
    ['POST', `/projects/admin/${id}/reorder-images`],
  ];
  for (const [method, urlPath] of cases) {
    // fetch() refuses a body on GET, so only send one where it is allowed.
    const body = method === 'GET' ? undefined : {};
    const asMember = await req(method, urlPath, { token: memberToken, body });
    assert.equal(asMember.status, 403, `${method} ${urlPath} must refuse a member`);
    const asAnon = await req(method, urlPath, { body });
    assert.equal(asAnon.status, 401, `${method} ${urlPath} must refuse a stranger`);
  }
});

test('the public listing and the spotlight need no sign-in', async () => {
  assert.equal((await req('GET', '/projects')).status, 200);
  assert.equal((await req('GET', '/projects/spotlight')).status, 200);
  assert.equal((await req('GET', '/projects/limits')).status, 200);
});
