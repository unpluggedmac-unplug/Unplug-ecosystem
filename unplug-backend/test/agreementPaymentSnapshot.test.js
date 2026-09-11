// Regression: a signed agreement's payment obligation is immutable.
// An admin editing, closing or archiving the agreement afterwards must not
// strand a signer who still needs to pay under the terms they actually signed.

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-agreement-snapshot-'));
const port = 64400 + (process.pid % 300); // unused base when this regression was added

async function api(method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
  return { status: res.status, body: parsed };
}

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'agreement-snapshot-test-secret';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const migrationDir = path.join(__dirname, '..', 'db', 'migrations');
  for (const name of fs.readdirSync(migrationDir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(migrationDir, name), 'utf8'));
  }

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const agreementForms = require('../src/routes/agreementForms');
  const app = express();
  app.use(express.json());
  app.use(require('../src/middleware/requestContext').middleware);
  app.use(attachUser);
  app.use('/agreement-forms', require('../src/middleware/agreementPaymentPolicy'));
  app.use('/agreement-forms', agreementForms.router);
  app.use('/agreement-payments', require('../src/routes/agreementPayments'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('AFTER-SIGN guest can still pay the signed snapshot after admin closes and changes the agreement', async () => {
  const made = await pool.query(`
    INSERT INTO agreement_forms
      (name,slug,title,description,signer_type,rules,terms,status,published,
       amount,payment_mode,guest_payment_allowed)
    VALUES
      ('Snapshot Agreement','snapshot-agreement','Snapshot Agreement','Purpose',
       'individual','Rule','Term','active',false,321,'after_sign',true)
    RETURNING id
  `);
  const agreementId = made.rows[0].id;
  await pool.query(`
    INSERT INTO agreement_fields
      (agreement_id,position,kind,field_key,label,required)
    VALUES ($1,10,'text','full_legal_name','Full legal name',true)
  `, [agreementId]);

  const signed = await api('POST', '/agreement-forms/snapshot-agreement/sign', {
    answers: { full_legal_name: 'Snapshot Guest' },
    signerName: 'Snapshot Guest',
    signerEmail: 'snapshot.guest@example.com',
    signatureType: 'typed',
    signatureText: 'Snapshot Guest',
  });
  assert.equal(signed.status, 201);
  assert.equal(signed.body.paymentRequired, true);
  assert.ok(signed.body.downloadToken);

  const frozen = await pool.query(
    `SELECT amount_at_signing,payment_mode_at_signing,guest_payment_allowed_at_signing
       FROM agreement_submissions WHERE id=$1`,
    [signed.body.submissionId]
  );
  assert.equal(Number(frozen.rows[0].amount_at_signing), 321);
  assert.equal(frozen.rows[0].payment_mode_at_signing, 'after_sign');
  assert.equal(frozen.rows[0].guest_payment_allowed_at_signing, true);

  // Simulate a later admin edit that would have stranded this signer before
  // the regression fix: current agreement is now free, hidden to guests and
  // archived. None of that may rewrite what was already signed.
  await pool.query(`
    UPDATE agreement_forms
       SET amount=0, payment_mode='none', guest_payment_allowed=false,
           status='archived', published=false, closes_at=now()-interval '1 day'
     WHERE id=$1
  `, [agreementId]);

  const wrongToken = await api('POST', '/agreement-payments/snapshot-agreement/start', {
    submissionId: signed.body.submissionId,
    downloadToken: 'wrong-token',
    termsAccepted: true,
  });
  assert.equal(wrongToken.status, 403, 'snapshot continuation is still protected by the guest credential');

  const payment = await api('POST', '/agreement-payments/snapshot-agreement/start', {
    submissionId: signed.body.submissionId,
    downloadToken: signed.body.downloadToken,
    termsAccepted: true,
  });
  assert.equal(payment.status, 201);
  assert.equal(payment.body.guest, true);
  assert.equal(payment.body.payment.amount, 321, 'charge the signed amount, never the edited current amount');
  assert.equal(payment.body.payment.status, 'pending');
  assert.equal(payment.body.instructions.reference, payment.body.payment.reference);

  const stored = await pool.query('SELECT * FROM payments WHERE id=$1', [payment.body.payment.id]);
  assert.equal(stored.rows[0].user_id, null);
  assert.equal(stored.rows[0].guest_payer_name, 'Snapshot Guest', 'signed identity can be reused; guest need not type it twice');
  assert.equal(stored.rows[0].guest_payer_email, 'snapshot.guest@example.com');
  assert.equal(Number(stored.rows[0].amount), 321);
  assert.equal(stored.rows[0].linked_type, 'agreement_payment');
});
