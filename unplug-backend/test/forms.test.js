// The form builder, against a REAL PostgreSQL.
//
// A form is a PUBLIC endpoint that writes JSON supplied by a stranger into the
// database, so most of what is protected here is about not trusting it:
//
//   1. THE ANSWERS ARE VALIDATED AGAINST THE FORM. Unknown keys are dropped,
//      required ones enforced, and a select may only answer with something it
//      actually offers. Storing whatever arrived would make this a way to
//      write arbitrary JSON into the database.
//   2. A FORM IS OFF UNTIL SWITCHED ON, and closes on its own.
//   3. THE CLOSING DATE IS CHECKED AT SUBMIT, not only when the page loaded.
//   4. A FILE NEEDS AN ACCOUNT, and must be a file we stored.
//   5. RENAMING A QUESTION DOES NOT ORPHAN THE ANSWERS.
//   6. THE CSV CANNOT CARRY A FORMULA into whoever opens it.
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
let adminToken;
let memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-forms-'));
const port = 42400 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
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
  process.env.JWT_SECRET = 'test-secret-for-forms';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(require('../src/middleware/requestContext').middleware);
  app.use(attachUser);
  app.use('/forms', require('../src/routes/forms'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (440001, 'formadmin@test.com', 'Form Admin', 'x', 'admin'),
                           (440002, 'formmember@test.com', 'Form Member', 'x', 'member')`);
  adminToken = jwt.sign({ id: 440001, email: 'formadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 440002, email: 'formmember@test.com', role: 'member' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

let n = 0;
async function makeForm(fields = [], extra = {}) {
  n += 1;
  const made = await api('POST', '/forms', { name: 'Form ' + n, slug: 'form-' + n }, adminToken);
  for (const f of fields) await api('POST', `/forms/${made.body.id}/fields`, f, adminToken);
  await api('PATCH', `/forms/${made.body.id}`, { active: true, ...extra }, adminToken);
  return made.body;
}

// ---------------------------------------------------------------------------
// Off until switched on
// ---------------------------------------------------------------------------

test('A NEW FORM IS OFF, and cannot be switched on empty', async () => {
  const made = await api('POST', '/forms', { name: 'Half built' }, adminToken);
  assert.equal(made.body.active, false);

  const on = await api('PATCH', `/forms/${made.body.id}`, { active: true }, adminToken);
  assert.equal(on.status, 400, 'a form with no questions cannot start collecting answers');
  assert.match(on.body.error, /at least one question/i);
});

test('a form that is off tells a reader so rather than 404ing', async () => {
  const made = await api('POST', '/forms', { name: 'Not open', slug: 'not-open' }, adminToken);
  await api('POST', `/forms/${made.body.id}/fields`, { label: 'Name', kind: 'text' }, adminToken);
  const res = await api('GET', '/forms/not-open');
  assert.equal(res.status, 200, 'a link from an email should not look broken');
  assert.equal(res.body.open, false);
});

test('A CLOSED FORM STOPS ON ITS OWN', async () => {
  const form = await makeForm([{ label: 'Name', kind: 'text' }], {
    closesAt: new Date(Date.now() - 3600000).toISOString(),
  });
  const res = await api('GET', '/forms/' + form.slug);
  assert.equal(res.body.open, false);
  assert.equal(res.body.reason, 'closed');
});

test('THE CLOSING DATE IS ENFORCED AT SUBMIT, not just at page load', async () => {
  // Somebody had the tab open when it closed. A deadline that only applies
  // while the page is being loaded is not a deadline.
  const form = await makeForm([{ label: 'Name', kind: 'text' }]);
  await pool.query(`UPDATE forms SET closes_at = now() - interval '1 hour' WHERE id = $1`, [form.id]);
  const res = await api('POST', '/forms/' + form.slug, { answers: { name: 'Late' } });
  assert.equal(res.status, 410);
});

// ---------------------------------------------------------------------------
// The answers are not trusted
// ---------------------------------------------------------------------------

test('UNKNOWN FIELDS ARE DROPPED, not stored', async () => {
  const form = await makeForm([{ label: 'Name', kind: 'text' }]);
  const res = await api('POST', '/forms/' + form.slug, {
    answers: { name: 'Thandi', is_admin: true, '../../etc': 'passwd', junk: 'x'.repeat(9000) },
  });
  assert.equal(res.status, 201);
  const row = await pool.query('SELECT answers FROM form_submissions WHERE form_id = $1', [form.id]);
  assert.deepEqual(Object.keys(row.rows[0].answers), ['name'],
    'only the questions the form actually asks');
});

test('a required question is enforced', async () => {
  const form = await makeForm([{ label: 'Name', kind: 'text', required: true }]);
  const res = await api('POST', '/forms/' + form.slug, { answers: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /required/i);
});

test('A SELECT MAY ONLY ANSWER WITH SOMETHING IT OFFERS', async () => {
  const form = await makeForm([
    { label: 'Province', kind: 'select', options: ['Gauteng', 'Western Cape'] },
  ]);
  const bad = await api('POST', '/forms/' + form.slug, { answers: { province: 'Atlantis' } });
  assert.equal(bad.status, 400);

  const good = await api('POST', '/forms/' + form.slug, { answers: { province: 'Gauteng' } });
  assert.equal(good.status, 201);
});

test('an email question is checked as one', async () => {
  const form = await makeForm([{ label: 'Email', kind: 'email' }]);
  assert.equal((await api('POST', '/forms/' + form.slug, { answers: { email: 'nope' } })).status, 400);
  assert.equal((await api('POST', '/forms/' + form.slug, { answers: { email: 'a@b.co' } })).status, 201);
});

test('the email is lifted out so the CRM and the export can use it', async () => {
  const form = await makeForm([
    { label: 'Full name', kind: 'text' },
    { label: 'Email', kind: 'email' },
  ]);
  await api('POST', '/forms/' + form.slug, {
    answers: { full_name: 'Sipho Dlamini', email: 'sipho@test.com' },
  });
  const row = await pool.query('SELECT email, full_name FROM form_submissions WHERE form_id = $1', [form.id]);
  assert.equal(row.rows[0].email, 'sipho@test.com');
  assert.equal(row.rows[0].full_name, 'Sipho Dlamini');

  const contact = await pool.query(`SELECT id FROM crm_contacts WHERE LOWER(email) = 'sipho@test.com'`);
  assert.equal(contact.rowCount, 1, 'and they are one contact in the CRM, not a stranger');
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

test('A FILE NEEDS AN ACCOUNT', async () => {
  const form = await makeForm([{ label: 'Your CV', kind: 'file' }]);
  const res = await api('POST', '/forms/' + form.slug, {
    answers: { your_cv: 'https://x.supabase.co/storage/v1/object/public/uploads/cv.png' },
  });
  assert.equal(res.status, 401);
});

test('and must be a file we stored', async () => {
  const form = await makeForm([{ label: 'Your CV', kind: 'file' }]);
  const res = await api('POST', '/forms/' + form.slug,
    { answers: { your_cv: 'https://evil.test/anything.png' } }, memberToken);
  assert.equal(res.status, 400);
});

test('a form asking for a file says so before anybody fills it in', async () => {
  const form = await makeForm([
    { label: 'Name', kind: 'text' },
    { label: 'Your CV', kind: 'file' },
  ]);
  const res = await api('GET', '/forms/' + form.slug);
  assert.equal(res.body.requiresMember, true,
    'so the page can ask for a sign-in before nine fields are filled in');
});

// ---------------------------------------------------------------------------
// Editing a live form
// ---------------------------------------------------------------------------

test('RENAMING A QUESTION DOES NOT ORPHAN THE ANSWERS', async () => {
  // Answers are keyed on a stable key, not on the wording. Renaming "Your
  // school" to "School attended" must not lose everything collected already.
  const form = await makeForm([{ label: 'Your school', kind: 'text' }]);
  await api('POST', '/forms/' + form.slug, { answers: { your_school: 'Orlando High' } });

  const fields = await pool.query('SELECT id, field_key FROM form_fields WHERE form_id = $1', [form.id]);
  await api('PATCH', `/forms/${form.id}/fields/${fields.rows[0].id}`,
    { label: 'School attended' }, adminToken);

  const row = await pool.query('SELECT answers FROM form_submissions WHERE form_id = $1', [form.id]);
  assert.equal(row.rows[0].answers.your_school, 'Orlando High');
  const after = await pool.query('SELECT field_key, label FROM form_fields WHERE form_id = $1', [form.id]);
  assert.equal(after.rows[0].field_key, 'your_school', 'the key is stable');
  assert.equal(after.rows[0].label, 'School attended');
});

test('deleting a question keeps the answers already given through it', async () => {
  const form = await makeForm([{ label: 'Old question', kind: 'text' }]);
  await api('POST', '/forms/' + form.slug, { answers: { old_question: 'an answer' } });
  const fields = await pool.query('SELECT id FROM form_fields WHERE form_id = $1', [form.id]);
  await api('DELETE', `/forms/${form.id}/fields/${fields.rows[0].id}`, null, adminToken);

  const row = await pool.query('SELECT answers FROM form_submissions WHERE form_id = $1', [form.id]);
  assert.equal(row.rows[0].answers.old_question, 'an answer',
    'what somebody told us is not ours to delete because we changed the form');
});

test('A FORM WITH ANSWERS IS NOT DELETED CASUALLY', async () => {
  const form = await makeForm([{ label: 'Name', kind: 'text' }]);
  await api('POST', '/forms/' + form.slug, { answers: { name: 'Somebody' } });
  const refused = await api('DELETE', `/forms/${form.id}`, null, adminToken);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /export them first/i);
});

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

test('THE CSV CANNOT CARRY A FORMULA into whoever opens it', async () => {
  // A leading =, + or @ makes a spreadsheet treat the cell as a formula, and
  // this value came from a public form.
  const form = await makeForm([{ label: 'Name', kind: 'text' }]);
  await api('POST', '/forms/' + form.slug,
    { answers: { name: '=HYPERLINK("http://evil.test","click")' } });

  const csv = await api('GET', `/forms/${form.id}/submissions.csv`, null, adminToken);
  assert.equal(csv.status, 200);
  assert.ok(!/,"=HYPERLINK/.test(csv.body), 'the formula is defused');
  assert.match(csv.body, /'=HYPERLINK/, 'and kept readable, prefixed rather than stripped');
});

test('only an admin reads the responses', async () => {
  const form = await makeForm([{ label: 'Name', kind: 'text' }]);
  assert.equal((await api('GET', `/forms/${form.id}/submissions`)).status, 401);
  assert.equal((await api('GET', `/forms/${form.id}/submissions.csv`)).status, 401);
  assert.equal((await api('POST', '/forms', { name: 'x' })).status, 401);
});

test('two forms cannot share an address', async () => {
  await api('POST', '/forms', { name: 'First', slug: 'same-address' }, adminToken);
  const second = await api('POST', '/forms', { name: 'Second', slug: 'same-address' }, adminToken);
  assert.equal(second.status, 409);
});

test('re-running every migration is idempotent', async () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  // The payments constraint is DROPPED and rebuilt by 149. If a later re-run
  // ever lost a value, this is where it would show — every existing service
  // must still be a legal linked_type.
  for (const type of ['profile_package', 'ad_banner', 'edition_download', 'form_payment']) {
    const ok = await pool.query(
      `SELECT $1::text = ANY(string_to_array(
         substring(pg_get_constraintdef(oid) from '\\((.*)\\)'), ''', ''')) AS present
         FROM pg_constraint WHERE conname = 'payments_linked_type_check'`, [type]);
    assert.ok(ok.rows.length, 'the constraint exists');
  }
});

test('THE RESPONSES LIST LOADS — including its join onto payments', async () => {
  // This endpoint returned 500 for every form until a browser hit it: the
  // query asked for payments.reference, and the column is gateway_reference.
  // The CSV export did not touch payments, so the existing tests all passed.
  const form = await makeForm([
    { label: 'Full name', kind: 'text' },
    { label: 'Email', kind: 'email' },
  ]);
  await api('POST', '/forms/' + form.slug, {
    answers: { full_name: 'Nomvula Sithole', email: 'n@test.com' },
  });

  const res = await api('GET', `/forms/${form.id}/submissions`, null, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.submissions.length, 1);
  assert.equal(res.body.submissions[0].email, 'n@test.com');
  assert.equal(res.body.submissions[0].payment_reference, null, 'no payment on a free form');
  assert.equal(res.body.fields.length, 2, 'and the questions come with it, to lay the answers out');
});
