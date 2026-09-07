// Admin content control — list, edit, trash/permanent delete, decline-with-credit — against a
// REAL PostgreSQL.
//
// This router takes the content type from the URL and uses it to choose a table.
// The tests protect the resource allow-list, editable-field guardrails,
// reversible Trash workflow, and decline-with-credit transaction behaviour.
//
// Run with: npm test (from unplug-backend/)

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-admincontent-'));
const port = 32400 + (process.pid % 300);

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
  return jwt.sign({ id: userId, email: `ac${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 661000;
let _slug = 0;

async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `ac${id}@test.com`, role]
  );
  return id;
}

async function makeArticle(userId, over = {}) {
  const r = await pool.query(
    `INSERT INTO articles (title, body, author_user_id, status)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [over.title || 'A Story', over.body || 'The original body.', userId, over.status || 'approved']);
  return r.rows[0];
}

async function makeProfile(over = {}) {
  const userId = await makeUser();
  const r = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, bio, status)
     VALUES ($1, 'business', 'basic', $2, $3, $4, $5) RETURNING *`,
    [userId, `ac-profile-${_slug++}`, over.displayName || 'A Business',
      over.bio || 'The original bio.', over.status || 'approved']);
  return r.rows[0];
}

let _ref = 0;
async function makePayment(userId, linkedType, linkedId, amount) {
  const r = await pool.query(
    `INSERT INTO payments (user_id, amount, linked_type, linked_id, status, method, gateway_reference)
     VALUES ($1, $2, $3, $4, 'confirmed', 'eft', $5) RETURNING *`,
    [userId, amount, linkedType, linkedId, `AC-TEST-${++_ref}`]);
  return r.rows[0];
}

async function creditBalance(userId) {
  const r = await pool.query(
    'SELECT COALESCE(SUM(amount), 0)::numeric AS b FROM account_credits WHERE user_id = $1', [userId]);
  return Number(r.rows[0].b);
}

let adminId;
let adminToken;
let memberId;
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
  process.env.JWT_SECRET = 'test-secret-for-admin-content';
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
  app.use('/admin/content', require('../src/routes/adminContent'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminId = await makeUser('admin');
  adminToken = tokenFor(adminId, 'admin');
  memberId = await makeUser();
  memberToken = tokenFor(memberId);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('AN UNKNOWN RESOURCE IS A 404 BEFORE ANY QUERY IS BUILT', async () => {
  const bad = await req('GET', '/admin/content/not_a_real_table', { token: adminToken });
  assert.equal(bad.status, 404);
  assert.match(bad.body.error, /unknown content type/i);
});

test('A SQL-INJECTION ATTEMPT IN THE RESOURCE NAME IS JUST A 404', async () => {
  const attempts = [
    'articles; DROP TABLE users',
    'articles%20UNION%20SELECT',
    "articles'--",
  ];
  for (const attempt of attempts) {
    const r = await req('GET', `/admin/content/${encodeURIComponent(attempt)}`, { token: adminToken });
    assert.equal(r.status, 404, `${attempt} must not be treated as a table name`);
  }
  const users = await pool.query('SELECT COUNT(*) AS n FROM users');
  assert.ok(Number(users.rows[0].n) > 0);
});

test('an unknown status filter is a clear 400, not a silently empty list', async () => {
  const bad = await req('GET', '/admin/content/articles?status=nonsense', { token: adminToken });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /unknown status/i);
});

test('a non-numeric id is a clean 400', async () => {
  const bad = await req('PATCH', '/admin/content/articles/abc', {
    token: adminToken, body: { title: 'x' },
  });
  assert.equal(bad.status, 400);
});

test('approved items are visible, not just pending ones', async () => {
  const article = await makeArticle(memberId, { title: 'Already Approved', status: 'approved' });
  const list = await req('GET', '/admin/content/articles?status=approved', { token: adminToken });
  assert.equal(list.status, 200);
  assert.ok(list.body.items.some((i) => i.id === article.id));
});

test('the list says which fields are editable, so the UI cannot guess wrong', async () => {
  const list = await req('GET', '/admin/content/articles', { token: adminToken });
  assert.ok(Array.isArray(list.body.editable));
  assert.ok(list.body.editable.includes('title'));
  assert.ok(!list.body.editable.includes('status'));
  assert.ok(!list.body.editable.includes('author_user_id'));
});

test('a resource with no status column ignores the status filter instead of erroring', async () => {
  const list = await req('GET', '/admin/content/edcal?status=approved', { token: adminToken });
  assert.equal(list.status, 200);
});

test('AN OMITTED FIELD IS LEFT ALONE, NOT BLANKED', async () => {
  const article = await makeArticle(memberId, { title: 'Keep My Body', body: 'Important text.' });
  const patched = await req('PATCH', `/admin/content/articles/${article.id}`, {
    token: adminToken, body: { title: 'New Headline' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.item.title, 'New Headline');
  assert.equal(patched.body.item.body, 'Important text.');
});

test('A FIELD THAT IS NOT EDITABLE IS IGNORED, NOT WRITTEN', async () => {
  const article = await makeArticle(memberId, { title: 'Status Guard', status: 'approved' });
  const attempt = await req('PATCH', `/admin/content/articles/${article.id}`, {
    token: adminToken, body: { title: 'Renamed', status: 'rejected' },
  });
  assert.equal(attempt.status, 200);
  assert.equal(attempt.body.item.status, 'approved');
});

test('ownership cannot be reassigned through an edit', async () => {
  const otherId = await makeUser();
  const article = await makeArticle(memberId, { title: 'Ownership Guard' });
  await req('PATCH', `/admin/content/articles/${article.id}`, {
    token: adminToken, body: { title: 'Still Theirs', author_user_id: otherId },
  });
  const row = await pool.query('SELECT author_user_id FROM articles WHERE id = $1', [article.id]);
  assert.equal(row.rows[0].author_user_id, memberId);
});

test('a request naming only non-editable fields is refused rather than doing nothing', async () => {
  const article = await makeArticle(memberId, { title: 'Nothing Usable' });
  const empty = await req('PATCH', `/admin/content/articles/${article.id}`, {
    token: adminToken, body: { status: 'rejected', id: 999 },
  });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /no editable fields/i);
});

test('a resource with nothing editable says so plainly', async () => {
  const bad = await req('PATCH', '/admin/content/entries/1', {
    token: adminToken, body: { anything: 'x' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /nothing that can be edited/i);
});

test('editing something that no longer exists is a 404', async () => {
  const gone = await req('PATCH', '/admin/content/articles/99999999', {
    token: adminToken, body: { title: 'Ghost' },
  });
  assert.equal(gone.status, 404);
});

test('an emptied text field becomes NULL rather than an empty string', async () => {
  const profile = await makeProfile({ bio: 'Some bio' });
  const patched = await req('PATCH', `/admin/content/profiles/${profile.id}`, {
    token: adminToken, body: { bio: '   ' },
  });
  assert.equal(patched.body.item.bio, null);
});

test('a profile slug cannot be changed here — the public URL stays put', async () => {
  const profile = await makeProfile();
  await req('PATCH', `/admin/content/profiles/${profile.id}`, {
    token: adminToken, body: { display_name: 'Renamed Business', slug: 'brand-new-slug' },
  });
  const row = await pool.query('SELECT slug, display_name FROM profiles WHERE id = $1', [profile.id]);
  assert.equal(row.rows[0].slug, profile.slug);
  assert.equal(row.rows[0].display_name, 'Renamed Business');
});

test('an admin can add a gallery image directly, already approved', async () => {
  const created = await req('POST', '/admin/content/gallery', {
    token: adminToken, body: { imageUrl: 'https://example.com/g.jpg', title: 'Direct Add' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.item.status, 'approved');
  assert.equal(created.body.item.owner_type, 'general');
});

test('a gallery image needs an image', async () => {
  const bad = await req('POST', '/admin/content/gallery', { token: adminToken, body: { title: 'No File' } });
  assert.equal(bad.status, 400);
});

test('an invalid visibility is refused with a message that names the options', async () => {
  const created = await req('POST', '/admin/content/gallery', {
    token: adminToken, body: { imageUrl: 'https://example.com/v.jpg' },
  });
  const bad = await req('PATCH', `/admin/content/gallery/${created.body.item.id}`, {
    token: adminToken, body: { visibility: 'sort-of-live' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /draft, published, unpublished or archived/i);
});

test('a non-numeric display order is refused before it reaches the database', async () => {
  const created = await req('POST', '/admin/content/gallery', {
    token: adminToken, body: { imageUrl: 'https://example.com/d.jpg' },
  });
  const bad = await req('PATCH', `/admin/content/gallery/${created.body.item.id}`, {
    token: adminToken, body: { display_order: 'first' },
  });
  assert.equal(bad.status, 400);
});

test('a gallery edit records who made it', async () => {
  const created = await req('POST', '/admin/content/gallery', {
    token: adminToken, body: { imageUrl: 'https://example.com/w.jpg' },
  });
  await req('PATCH', `/admin/content/gallery/${created.body.item.id}`, {
    token: adminToken, body: { caption: 'A new caption' },
  });
  const row = await pool.query('SELECT updated_by, updated_at FROM gallery_images WHERE id = $1',
    [created.body.item.id]);
  assert.equal(row.rows[0].updated_by, adminId);
  assert.ok(row.rows[0].updated_at);
});

test('permanent delete is blocked until the item is moved to Trash', async () => {
  const article = await makeArticle(memberId, { title: 'Delete Guard' });
  const blocked = await req('DELETE', `/admin/content/articles/${article.id}`, { token: adminToken });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /move this item to trash/i);
  const row = await pool.query('SELECT id FROM articles WHERE id = $1', [article.id]);
  assert.equal(row.rowCount, 1, 'a direct permanent-delete attempt must not remove the live row');
});

test('Trash is reversible and permanent delete works only after Trash', async () => {
  const article = await makeArticle(memberId, { title: 'To Be Deleted', status: 'approved' });

  const trashed = await req('POST', `/admin/content/articles/${article.id}/trash`, { token: adminToken });
  assert.equal(trashed.status, 200);
  assert.equal(trashed.body.trashed, true);
  assert.equal(trashed.body.previousStatus, 'approved');

  let row = await pool.query('SELECT status FROM articles WHERE id = $1', [article.id]);
  assert.equal(row.rows[0].status, 'rejected', 'Trash takes the item offline without deleting it');

  const restored = await req('POST', `/admin/content/articles/${article.id}/restore`, { token: adminToken });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.status, 'approved');

  const trashedAgain = await req('POST', `/admin/content/articles/${article.id}/trash`, { token: adminToken });
  assert.equal(trashedAgain.status, 200);
  assert.equal((await req('DELETE', `/admin/content/articles/${article.id}`, { token: adminToken })).status, 200);

  row = await pool.query('SELECT id FROM articles WHERE id = $1', [article.id]);
  assert.equal(row.rowCount, 0);
});

test('DELETING A PAID ITEM LEAVES THE PAYMENT STANDING — IT IS NOT A REFUND', async () => {
  const article = await makeArticle(memberId, { title: 'Paid For' });
  const payment = await makePayment(memberId, 'article_publish', article.id, 95.00);

  assert.equal((await req('POST', `/admin/content/articles/${article.id}/trash`, { token: adminToken })).status, 200);
  assert.equal((await req('DELETE', `/admin/content/articles/${article.id}`, { token: adminToken })).status, 200);

  const still = await pool.query('SELECT status FROM payments WHERE id = $1', [payment.id]);
  assert.equal(still.rows[0].status, 'confirmed', 'the payment record survives the deletion');
  assert.equal(await creditBalance(memberId), 0, 'and nothing was refunded — use decline-with-credit for that');
});

test('the payment preview tells the admin the real amount before they click', async () => {
  const article = await makeArticle(memberId, { title: 'Preview Me', status: 'pending' });
  await makePayment(memberId, 'article_publish', article.id, 95.00);
  const preview = await req('GET', `/admin/content/articles/${article.id}/payment`, { token: adminToken });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.payable, true);
  assert.equal(preview.body.payment.amount, 95);
  assert.equal(preview.body.payment.alreadyCredited, false);
});

test('the preview says so when there is no payment to give back', async () => {
  const article = await makeArticle(memberId, { title: 'Free Submission', status: 'pending' });
  const preview = await req('GET', `/admin/content/articles/${article.id}/payment`, { token: adminToken });
  assert.equal(preview.body.payable, true);
  assert.equal(preview.body.payment, null);
});

test('the preview says a content type is not payable at all', async () => {
  const preview = await req('GET', '/admin/content/edcal/1/payment', { token: adminToken });
  assert.equal(preview.body.payable, false);
});

test('DECLINING WITH CREDIT REJECTS AND CREDITS TOGETHER', async () => {
  const userId = await makeUser();
  const article = await makeArticle(userId, { title: 'Declined Story', status: 'pending' });
  await makePayment(userId, 'article_publish', article.id, 95.00);
  const declined = await req('POST', `/admin/content/articles/${article.id}/decline-with-credit`, {
    token: adminToken, body: { note: 'Not right for us' },
  });
  assert.equal(declined.status, 200);
  assert.equal(declined.body.credited, 95);
  assert.equal(declined.body.newBalance, 95);
  const row = await pool.query('SELECT status FROM articles WHERE id = $1', [article.id]);
  assert.equal(row.rows[0].status, 'credit_issued');
  assert.equal(await creditBalance(userId), 95);
});

test('THE SAME PAYMENT CANNOT BE CREDITED TWICE', async () => {
  const userId = await makeUser();
  const article = await makeArticle(userId, { title: 'Double Click', status: 'pending' });
  await makePayment(userId, 'article_publish', article.id, 95.00);
  const first = await req('POST', `/admin/content/articles/${article.id}/decline-with-credit`, { token: adminToken });
  assert.equal(first.status, 200);
  const second = await req('POST', `/admin/content/articles/${article.id}/decline-with-credit`, { token: adminToken });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already been credited/i);
  assert.equal(await creditBalance(userId), 95);
});

test('two simultaneous declines credit once between them', async () => {
  const userId = await makeUser();
  const article = await makeArticle(userId, { title: 'Race Condition', status: 'pending' });
  await makePayment(userId, 'article_publish', article.id, 300.00);
  const [a, b] = await Promise.all([
    req('POST', `/admin/content/articles/${article.id}/decline-with-credit`, { token: adminToken }),
    req('POST', `/admin/content/articles/${article.id}/decline-with-credit`, { token: adminToken }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(await creditBalance(userId), 300);
});

test('declining an unpaid submission credits nothing and changes nothing', async () => {
  const userId = await makeUser();
  const article = await makeArticle(userId, { title: 'Never Paid', status: 'pending' });
  const refused = await req('POST', `/admin/content/articles/${article.id}/decline-with-credit`, { token: adminToken });
  assert.equal(refused.status, 404);
  assert.match(refused.body.error, /reject it normally/i);
  const row = await pool.query('SELECT status FROM articles WHERE id = $1', [article.id]);
  assert.equal(row.rows[0].status, 'pending');
});

test('an unconfirmed payment is not treated as money received', async () => {
  const userId = await makeUser();
  const article = await makeArticle(userId, { title: 'Awaiting EFT', status: 'pending' });
  await pool.query(
    `INSERT INTO payments (user_id, amount, linked_type, linked_id, status, method, gateway_reference)
     VALUES ($1, 95.00, 'article_publish', $2, 'pending', 'eft', $3)`,
    [userId, article.id, `AC-TEST-UNPAID-${++_ref}`]);
  const refused = await req('POST', `/admin/content/articles/${article.id}/decline-with-credit`, { token: adminToken });
  assert.equal(refused.status, 404);
  assert.equal(await creditBalance(userId), 0);
});

test('a content type with no paid submissions is refused with a reason', async () => {
  const bad = await req('POST', '/admin/content/edcal/1/decline-with-credit', { token: adminToken });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not something that gets approved or paid for/i);
});

test('the credit records which payment it came from', async () => {
  const userId = await makeUser();
  const article = await makeArticle(userId, { title: 'Traceable', status: 'pending' });
  const payment = await makePayment(userId, 'article_publish', article.id, 95.00);
  await req('POST', `/admin/content/articles/${article.id}/decline-with-credit`, {
    token: adminToken, body: { note: 'Off topic' },
  });
  const credit = await pool.query('SELECT * FROM account_credits WHERE payment_id = $1', [payment.id]);
  assert.equal(credit.rowCount, 1);
  assert.equal(credit.rows[0].reason, 'declined_submission');
  assert.match(credit.rows[0].note, /Off topic/);
  assert.equal(credit.rows[0].created_by, adminId);
  const flagged = await pool.query('SELECT credited_at FROM payments WHERE id = $1', [payment.id]);
  assert.ok(flagged.rows[0].credited_at);
});

test('a decline with no note still gets a useful one', async () => {
  const userId = await makeUser();
  const article = await makeArticle(userId, { title: 'No Note', status: 'pending' });
  const payment = await makePayment(userId, 'article_publish', article.id, 95.00);
  await req('POST', `/admin/content/articles/${article.id}/decline-with-credit`, { token: adminToken });
  const credit = await pool.query('SELECT note FROM account_credits WHERE payment_id = $1', [payment.id]);
  assert.match(credit.rows[0].note, /articles/i);
});

test('every endpoint here is admin-only', async () => {
  const cases = [
    ['GET', '/admin/content/articles'],
    ['POST', '/admin/content/gallery'],
    ['PATCH', '/admin/content/articles/1'],
    ['POST', '/admin/content/articles/1/trash'],
    ['POST', '/admin/content/articles/1/restore'],
    ['DELETE', '/admin/content/articles/1'],
    ['GET', '/admin/content/articles/1/payment'],
    ['POST', '/admin/content/articles/1/decline-with-credit'],
  ];
  for (const [method, urlPath] of cases) {
    const body = method === 'GET' ? undefined : {};
    const asMember = await req(method, urlPath, { token: memberToken, body });
    assert.equal(asMember.status, 403, `${method} ${urlPath} must refuse a member`);
    const asAnon = await req(method, urlPath, { body });
    assert.equal(asAnon.status, 401, `${method} ${urlPath} must refuse a stranger`);
  }
});
