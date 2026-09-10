// Agreement Forms payment policy / EFT bridge, against a REAL PostgreSQL.
//
// Protects option C selected by the site owner:
//   * admin chooses guest payment or account-required per agreement;
//   * the choice is enforced server-side at BOTH payment and signature;
//   * the payment amount/policy are snapshotted so later admin edits do not
//     rewrite an in-progress or already-signed agreement;
//   * guest money still lands in the existing payments ledger and the existing
//     EFT confirmation lifecycle moves the agreement forward.

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-agreement-payments-'));
const port = 63600 + (process.pid % 300); // bases are 400 apart; 63600 was unused when added

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
  return { status: res.status, body: parsed, headers: res.headers };
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
  process.env.JWT_SECRET = 'agreement-payment-test-secret';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const migrationDir = path.join(__dirname, '..', 'db', 'migrations');
  for (const name of fs.readdirSync(migrationDir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(migrationDir, name), 'utf8'));
  }

  await pool.query(`INSERT INTO users (id,email,full_name,password_hash,role)
                    VALUES (636001,'agreement-admin@test.com','Agreement Admin','x','admin'),
                           (636002,'agreement-member@test.com','Agreement Member','x','member')`);

  const jwt = require('jsonwebtoken');
  adminToken = jwt.sign({ id: 636001, email: 'agreement-admin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 636002, email: 'agreement-member@test.com', role: 'member' }, process.env.JWT_SECRET);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const forms = require('../src/routes/agreementForms');
  const app = express();
  app.use(express.json());
  app.use(require('../src/middleware/requestContext').middleware);
  app.use(attachUser);
  app.use('/agreement-forms', require('../src/middleware/agreementPaymentPolicy'));
  app.use('/agreement-forms', forms.router);
  app.use('/a', forms.shortLinkRouter);
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

let seq = 0;
async function makeAgreement({ paymentMode = 'before_sign', guest = false, amount = 500 } = {}) {
  seq += 1;
  const slug = `agreement-pay-${seq}`;
  const r = await pool.query(
    `INSERT INTO agreement_forms
       (name,slug,title,description,signer_type,rules,terms,status,published,
        amount,payment_mode,guest_payment_allowed,created_by)
     VALUES ($1,$2,$3,'Test agreement','individual','Rule one','Terms one',
             'active',false,$4,$5,$6,636001)
     RETURNING *`,
    [`Agreement Pay ${seq}`, slug, `Agreement Pay ${seq}`, amount, paymentMode, guest]
  );
  await pool.query(
    `INSERT INTO agreement_fields
       (agreement_id,position,kind,field_key,label,required)
     VALUES ($1,10,'text','full_legal_name','Full legal name',true)`,
    [r.rows[0].id]
  );
  return r.rows[0];
}

async function sign(slug, extra = {}, token) {
  return api('POST', `/agreement-forms/${slug}/sign`, {
    answers: { full_legal_name: 'Guest Signer' },
    signerName: 'Guest Signer',
    signerEmail: 'guest@example.com',
    signatureType: 'typed',
    signatureText: 'Guest Signer',
    ...extra,
  }, token);
}

test('payments.user_id is nullable but existing member payments remain supported', async () => {
  const c = await pool.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='payments' AND column_name='user_id'`
  );
  assert.equal(c.rows[0].is_nullable, 'YES');

  const member = await pool.query(
    `INSERT INTO payments(user_id,amount,method,gateway_reference,status,linked_type,linked_id)
     VALUES(636002,1,'eft','6360000001','pending','marketplace_listing',999999)
     RETURNING user_id`
  );
  assert.equal(member.rows[0].user_id, 636002);
});

test('paid agreements default to ACCOUNT REQUIRED', async () => {
  const a = await makeAgreement();
  const options = await api('GET', `/agreement-payments/${a.slug}/options`);
  assert.equal(options.status, 200);
  assert.equal(options.body.guestPaymentAllowed, false);
  assert.equal(options.body.accountRequiredForPayment, true);
  assert.deepEqual(options.body.liveMethods, ['eft']);

  const denied = await api('POST', `/agreement-payments/${a.slug}/start`, {
    payerName: 'Guest', payerEmail: 'guest@example.com', termsAccepted: true,
  });
  assert.equal(denied.status, 401);
});

test('admin can switch ONE agreement to guest payment without changing another', async () => {
  const guestAgreement = await makeAgreement();
  const stillMemberOnly = await makeAgreement();

  const changed = await api('PATCH', `/agreement-payments/admin/${guestAgreement.id}`,
    { guestPaymentAllowed: true }, adminToken);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.guestPaymentAllowed, true);

  const rows = await pool.query(
    'SELECT id,guest_payment_allowed FROM agreement_forms WHERE id=ANY($1::int[]) ORDER BY id',
    [[guestAgreement.id, stillMemberOnly.id]]
  );
  const map = Object.fromEntries(rows.rows.map((x) => [x.id, x.guest_payment_allowed]));
  assert.equal(map[guestAgreement.id], true);
  assert.equal(map[stillMemberOnly.id], false, 'option C is per agreement, never a global switch');
});

test('guest BEFORE-SIGN checkout creates a normal pending EFT payment in the existing ledger', async () => {
  const a = await makeAgreement({ guest: true, amount: 750, paymentMode: 'before_sign' });
  const started = await api('POST', `/agreement-payments/${a.slug}/start`, {
    payerName: 'External Partner',
    payerEmail: 'partner@example.com',
    termsAccepted: true,
    method: 'eft',
  });
  assert.equal(started.status, 201);
  assert.equal(started.body.guest, true);
  assert.equal(started.body.payment.amount, 750);
  assert.equal(started.body.payment.status, 'pending');
  assert.match(started.body.payment.reference, /^\d{10}$/);
  assert.equal(started.body.instructions.reference, started.body.payment.reference);
  assert.ok(started.body.signingToken);

  const p = await pool.query('SELECT * FROM payments WHERE id=$1', [started.body.payment.id]);
  assert.equal(p.rows[0].user_id, null);
  assert.equal(p.rows[0].guest_payer_name, 'External Partner');
  assert.equal(p.rows[0].guest_payer_email, 'partner@example.com');
  assert.equal(p.rows[0].linked_type, 'agreement_payment');
  assert.equal(Number(p.rows[0].order_total), 750);
  assert.ok(p.rows[0].terms_accepted_at);

  const s = await pool.query('SELECT * FROM agreement_submissions WHERE id=$1', [started.body.submissionId]);
  assert.equal(s.rows[0].guest_payment_allowed_at_signing, true);
  assert.equal(Number(s.rows[0].amount_at_signing), 750);
  assert.equal(s.rows[0].payment_id, p.rows[0].id, 'payment trigger links the shared ledger back to the signing session');
});

test('refresh/double-click with the signing token returns the SAME pending payment', async () => {
  const a = await makeAgreement({ guest: true, amount: 300, paymentMode: 'before_sign' });
  const first = await api('POST', `/agreement-payments/${a.slug}/start`, {
    payerName: 'Repeat Guest', payerEmail: 'repeat@example.com', termsAccepted: true,
  });
  const again = await api('POST', `/agreement-payments/${a.slug}/start`, {
    payerName: 'Repeat Guest', payerEmail: 'repeat@example.com', termsAccepted: true,
    signingToken: first.body.signingToken,
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.payment.id, first.body.payment.id);
  assert.equal(again.body.payment.reference, first.body.payment.reference);

  const count = await pool.query(
    `SELECT count(*)::int AS n FROM payments
      WHERE linked_type='agreement_payment' AND linked_id=$1`,
    [first.body.submissionId]
  );
  assert.equal(count.rows[0].n, 1);
});

test('confirming guest EFT unlocks BEFORE-SIGN session and guest can sign', async () => {
  const a = await makeAgreement({ guest: true, amount: 425, paymentMode: 'before_sign' });
  const started = await api('POST', `/agreement-payments/${a.slug}/start`, {
    payerName: 'Paid Guest', payerEmail: 'paid@example.com', termsAccepted: true,
  });

  const premature = await sign(a.slug, { signingToken: started.body.signingToken });
  assert.equal(premature.status, 402, 'signature stays blocked until payment is confirmed');

  await pool.query("UPDATE payments SET status='confirmed', confirmed_at=now() WHERE id=$1", [started.body.payment.id]);
  const state = await api('GET', `/agreement-payments/${a.slug}/session/${started.body.signingToken}`);
  assert.equal(state.status, 200);
  assert.equal(state.body.readyToSign, true);

  const signed = await sign(a.slug, { signingToken: started.body.signingToken });
  assert.equal(signed.status, 201);
  assert.equal(signed.body.signed, true);

  const row = await pool.query('SELECT signed_at,payment_status,status FROM agreement_submissions WHERE id=$1', [started.body.submissionId]);
  assert.ok(row.rows[0].signed_at);
  assert.equal(row.rows[0].payment_status, 'confirmed');
  assert.equal(row.rows[0].status, 'complete');
});

test('ACCOUNT REQUIRED is enforced again at the actual signature boundary', async () => {
  const a = await makeAgreement({ guest: false, amount: 200, paymentMode: 'after_sign' });
  const denied = await sign(a.slug);
  assert.equal(denied.status, 401);
  assert.equal(denied.body.accountRequired, true);

  const memberSigned = await sign(a.slug, {}, memberToken);
  assert.equal(memberSigned.status, 201);
});

test('signed-in member can pay a member-only BEFORE-SIGN agreement', async () => {
  const a = await makeAgreement({ guest: false, amount: 650, paymentMode: 'before_sign' });
  const started = await api('POST', `/agreement-payments/${a.slug}/start`, {
    termsAccepted: true,
  }, memberToken);
  assert.equal(started.status, 201);
  assert.equal(started.body.guest, false);

  const p = await pool.query('SELECT user_id,guest_payer_email FROM payments WHERE id=$1', [started.body.payment.id]);
  assert.equal(p.rows[0].user_id, 636002);
  assert.equal(p.rows[0].guest_payer_email, null);
});

test('guest AFTER-SIGN flow signs first, then pays using the signed record token', async () => {
  const a = await makeAgreement({ guest: true, amount: 999, paymentMode: 'after_sign' });
  const signed = await sign(a.slug);
  assert.equal(signed.status, 201);
  assert.equal(signed.body.paymentRequired, true);
  assert.ok(signed.body.downloadToken);

  const payment = await api('POST', `/agreement-payments/${a.slug}/start`, {
    submissionId: signed.body.submissionId,
    downloadToken: signed.body.downloadToken,
    payerName: 'After Sign Guest',
    payerEmail: 'aftersign@example.com',
    termsAccepted: true,
  });
  assert.equal(payment.status, 201);
  assert.equal(payment.body.payment.amount, 999);

  await pool.query("UPDATE payments SET status='confirmed', confirmed_at=now() WHERE id=$1", [payment.body.payment.id]);
  const s = await pool.query('SELECT payment_status,status FROM agreement_submissions WHERE id=$1', [signed.body.submissionId]);
  assert.equal(s.rows[0].payment_status, 'confirmed');
  assert.equal(s.rows[0].status, 'complete');
});

test('a later admin price/policy edit does not rewrite an already-started session', async () => {
  const a = await makeAgreement({ guest: true, amount: 111, paymentMode: 'before_sign' });
  const started = await api('POST', `/agreement-payments/${a.slug}/start`, {
    payerName: 'Snapshot Guest', payerEmail: 'snapshot@example.com', termsAccepted: true,
  });

  await pool.query('UPDATE agreement_forms SET amount=9999,guest_payment_allowed=false WHERE id=$1', [a.id]);

  const resumed = await api('POST', `/agreement-payments/${a.slug}/start`, {
    payerName: 'Snapshot Guest', payerEmail: 'snapshot@example.com', termsAccepted: true,
    signingToken: started.body.signingToken,
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.payment.amount, 111, 'money is frozen at session start');

  const snapshot = await pool.query(
    'SELECT amount_at_signing,guest_payment_allowed_at_signing FROM agreement_submissions WHERE id=$1',
    [started.body.submissionId]
  );
  assert.equal(Number(snapshot.rows[0].amount_at_signing), 111);
  assert.equal(snapshot.rows[0].guest_payment_allowed_at_signing, true, 'guest permission is frozen with the session');
});
