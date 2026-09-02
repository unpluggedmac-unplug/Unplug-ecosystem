// Finding a submission's reference, and finding a submission from a reference.
//
// Spec §10.1 wants the reference to link submission to payment to approval to
// invoice. The link exists, but only in one direction — a payment points at a
// submission, and nothing points back. src/utils/submissionReference.js is that
// join.
//
// What these protect:
//
//   1. BOTH SHAPES OF REFERENCE RESOLVE. A cart purchase quotes the order's
//      UNP- reference; a single purchase quotes the payment's gateway
//      reference. A customer reading a bank statement does not know which they
//      have, so both must work.
//   2. ONE ORDER CAN HOLD SEVERAL SERVICES. That is what the cart is for, so
//      looking up a reference returns a list, not a row.
//   3. EVERY PAYMENT TYPE MAPS TO A REAL TABLE. A type that resolved to
//      nothing would be a submission nobody could find from its money.

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
let R;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-subref-'));
const port = 47200 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

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

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  R = require('../src/utils/submissionReference');

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (720001, 'ref@test.com', 'Ref Tester', 'x', 'member')`);
});

after(async () => {
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// A payment against a submission, optionally inside a cart order.
async function pay({ linkedType, linkedId, orderRef }) {
  let orderId = null;
  if (orderRef) {
    const o = await pool.query(
      `INSERT INTO orders (user_id, reference, method, subtotal, total,
                           terms_version, terms_accepted_at, info_confirmed_at)
       VALUES (720001, $1, 'eft', 100, 100, '2026.07.29', now(), now()) RETURNING id`,
      [orderRef]
    );
    orderId = o.rows[0].id;
  }
  const gw = 'GW' + Math.random().toString(36).slice(2, 10).toUpperCase();
  const p = await pool.query(
    `INSERT INTO payments (user_id, gateway_reference, amount, method, linked_type, linked_id, status, order_id)
     VALUES (720001, $1, 100, 'eft', $2, $3, 'confirmed', $4) RETURNING id`,
    [gw, linkedType, linkedId, orderId]
  );
  return { paymentId: p.rows[0].id, gatewayReference: gw, orderId };
}

// ---------------------------------------------------------------------------

test('EVERY PAYMENT TYPE POINTS AT A REAL TABLE', async () => {
  // A linked_type resolving to nothing is a submission that cannot be found
  // from its own money. Checked against the database rather than a list.
  const missing = [];
  for (const [type, table] of Object.entries(R.SUBMISSION_TABLE)) {
    const r = await pool.query(
      `SELECT to_regclass($1) IS NOT NULL AS exists`, [table]
    );
    if (!r.rows[0].exists) missing.push(`${type} -> ${table}`);
  }
  assert.deepEqual(missing, [], 'linked types pointing at tables that do not exist');
});

test('every linked_type the database allows is mapped', async () => {
  // The constraint is the authority on what types can exist. A type allowed by
  // the database but unmapped here is a gap that only shows when somebody buys
  // that thing.
  const r = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'payments_linked_type_check'`
  );
  assert.equal(r.rows.length, 1, 'the linked_type constraint should exist');
  const allowed = [...r.rows[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const unmapped = allowed.filter((t) => !R.SUBMISSION_TABLE[t]);
  assert.deepEqual(unmapped, [], 'payment types with nowhere to resolve to');
});

// ------------------------------------------------------------ resolving

test('A CART PURCHASE RESOLVES TO THE ORDER REFERENCE', async () => {
  // This is the one the customer was shown at checkout and wrote on the EFT.
  await pay({ linkedType: 'article_publish', linkedId: 9001, orderRef: 'UNP-CARTREF001' });
  const got = await R.referenceFor('article_publish', 9001, pool);
  assert.equal(got.reference, 'UNP-CARTREF001');
  assert.equal(got.kind, 'order');
  assert.ok(got.orderId);
});

test('a single purchase resolves to the payment reference', async () => {
  const made = await pay({ linkedType: 'event_listing', linkedId: 9002 });
  const got = await R.referenceFor('event_listing', 9002, pool);
  assert.equal(got.reference, made.gatewayReference);
  assert.equal(got.kind, 'payment');
  assert.equal(got.orderId, null);
});

test('nothing paid means no reference, not an invented one', async () => {
  // A draft article genuinely has no reference. Saying so beats making one up.
  assert.equal(await R.referenceFor('article_publish', 999999, pool), null);
});

test('an unknown type or a bad id resolves to nothing rather than throwing', async () => {
  assert.equal(await R.referenceFor('not_a_type', 1, pool), null);
  assert.equal(await R.referenceFor('article_publish', 'abc', pool), null);
  assert.equal(await R.referenceFor('article_publish', null, pool), null);
});

test('the most recent payment wins when a submission was paid twice', async () => {
  // Happens with a retry after a failed gateway attempt. The later reference is
  // the one the customer is holding.
  await pay({ linkedType: 'highlight', linkedId: 9003, orderRef: 'UNP-FIRSTTRY01' });
  await new Promise((r) => setTimeout(r, 10));
  await pay({ linkedType: 'highlight', linkedId: 9003, orderRef: 'UNP-SECONDTRY1' });
  const got = await R.referenceFor('highlight', 9003, pool);
  assert.equal(got.reference, 'UNP-SECONDTRY1');
});

// ------------------------------------------------- the other direction

test('ONE ORDER CAN HOLD SEVERAL SERVICES', async () => {
  // The whole point of the cart. A reference lookup that returned one row would
  // hide everything else the customer bought in the same transaction.
  await pay({ linkedType: 'gallery_bundle', linkedId: 9101, orderRef: 'UNP-MULTIBUY01' });
  const o = await pool.query('SELECT id FROM orders WHERE reference = $1', ['UNP-MULTIBUY01']);
  await pool.query(
    `INSERT INTO payments (user_id, gateway_reference, amount, method, linked_type, linked_id, status, order_id)
     VALUES (720001, 'GWMULTI2', 100, 'eft', 'marketplace_listing', 9102, 'confirmed', $1)`,
    [o.rows[0].id]
  );

  const found = await R.submissionsForReference('UNP-MULTIBUY01', pool);
  assert.equal(found.length, 2, 'both services on the order should come back');
  assert.deepEqual(found.map((f) => f.linkedType).sort(),
    ['gallery_bundle', 'marketplace_listing']);
  assert.deepEqual(found.map((f) => f.table).sort(),
    ['gallery_bundles', 'marketplace_listings']);
});

test('a gateway reference finds its submission too', async () => {
  const made = await pay({ linkedType: 'top10_entry', linkedId: 9103 });
  const found = await R.submissionsForReference(made.gatewayReference, pool);
  assert.equal(found.length, 1);
  assert.equal(found[0].linkedType, 'top10_entry');
  assert.equal(found[0].kind, 'payment');
});

test('an unknown reference finds nothing, and says so with an empty list', async () => {
  assert.deepEqual(await R.submissionsForReference('UNP-NOSUCHREF9', pool), []);
  assert.deepEqual(await R.submissionsForReference('', pool), []);
  assert.deepEqual(await R.submissionsForReference(null, pool), []);
});

test('the round trip holds: submission to reference and back', async () => {
  await pay({ linkedType: 'competition_entry', linkedId: 9104, orderRef: 'UNP-ROUNDTRIP' });
  const ref = await R.referenceFor('competition_entry', 9104, pool);
  const back = await R.submissionsForReference(ref.reference, pool);
  assert.ok(back.some((b) => b.linkedType === 'competition_entry' && b.linkedId === 9104),
    'the reference must lead back to the submission it came from');
});

test('profiles are reachable by BOTH of their payment types', () => {
  // A profile can be paid for as a package and again as an upgrade. A mapping
  // that assumed one type per table would silently lose upgrades.
  assert.ok(R.LINKED_TYPES_FOR.profiles.includes('profile_package'));
  assert.equal(R.SUBMISSION_TABLE.profile_upgrade, 'profile_upgrades',
    'an upgrade is its own row, not the profile');
});

// ---------------------------------------------------------------------------
// The status constraints, checked against a REAL database.
// ---------------------------------------------------------------------------
//
// submissionStatus.test.js reads the migration FILES. That proves the module
// matches what the migrations say, but not what a database ends up with — and
// there is one failure it cannot see.
//
// Changing a CHECK means DROP CONSTRAINT IF EXISTS <name> then ADD. If the
// original constraint was ever created under a DIFFERENT name, the DROP is a
// silent no-op, the ADD succeeds, and the table ends up with TWO status checks.
// Both are enforced, so the old one keeps rejecting every new value — and the
// migration that "added" them appears to have worked. Migration 016 exists
// because a missing value in a constraint broke gallery submissions for
// months without anyone noticing.
//
// These tests run after every migration has actually executed, so they see
// what Postgres really has.

const SUB = require('../src/utils/submissionStatus');

async function statusChecksFor(table) {
  const r = await pool.query(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%status%'`,
    [table]
  );
  return r.rows;
}

test('EXACTLY ONE STATUS CONSTRAINT PER TABLE, NOT TWO', async () => {
  // Two would mean the older one is still quietly rejecting the new values.
  const doubled = [];
  for (const table of SUB.SUBMISSION_TABLES) {
    const checks = await statusChecksFor(table);
    if (checks.length > 1) {
      doubled.push(`${table}: ${checks.map((c) => c.conname).join(' + ')}`);
    }
  }
  assert.deepEqual(doubled, [],
    'tables carrying more than one status CHECK — the older one still applies:\n  '
    + doubled.join('\n  '));
});

test('THE DATABASE ACCEPTS EXACTLY WHAT THE MODULE CLAIMS', async () => {
  // The same both-directions check as submissionStatus.test.js, but against a
  // real schema rather than the migration text.
  const problems = [];
  for (const table of SUB.SUBMISSION_TABLES) {
    const checks = await statusChecksFor(table);
    assert.equal(checks.length, 1, `${table} should have one status CHECK`);
    const actual = [...checks[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    const declared = SUB.liveStatusesFor(table).sort();
    if (JSON.stringify(actual) !== JSON.stringify(declared)) {
      problems.push(`${table}: database [${actual}] vs module [${declared}]`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n  '));
});

test('PHASE B1: a gallery row can really be set to the new statuses', async () => {
  // The point of the migration. Asserted by writing the values, because a
  // constraint that looks right and rejects the value is the failure mode.
  const b = await pool.query(
    `INSERT INTO gallery_bundles (user_id, image_count, status)
     VALUES (720001, 3, 'pending') RETURNING id`
  );
  const id = b.rows[0].id;
  for (const s of ['changes_requested', 'resubmitted', 'credit_issued']) {
    await pool.query('UPDATE gallery_bundles SET status = $1 WHERE id = $2', [s, id]);
    const got = await pool.query('SELECT status FROM gallery_bundles WHERE id = $1', [id]);
    assert.equal(got.rows[0].status, s, `gallery_bundles rejected ${s}`);
  }
});

test('a status nobody agreed to is still refused', async () => {
  // The constraint has to keep doing its job, or adding values is meaningless.
  //
  // The invalid value is kept SHORT on purpose: status is VARCHAR(20), so a
  // longer string is rejected for its length before the CHECK is ever reached,
  // and the test would pass without proving anything about the constraint.
  const b = await pool.query(
    `INSERT INTO gallery_bundles (user_id, image_count, status)
     VALUES (720001, 1, 'pending') RETURNING id`
  );
  await assert.rejects(
    () => pool.query('UPDATE gallery_bundles SET status = $1 WHERE id = $2',
      ['nonsense', b.rows[0].id]),
    /violates check constraint/
  );
});

test('EVERY STATUS FITS THE COLUMN IT HAS TO LIVE IN', async () => {
  // status is VARCHAR(20). A longer name is refused for its length, which reads
  // as a mysterious "value too long" rather than anything about statuses — as
  // this test file found out the hard way.
  //
  // Worth guarding now: Phase B still has services to migrate, and the spec's
  // own vocabulary contains names close to the limit. Checked against the real
  // column width rather than a remembered 20.
  const col = await pool.query(
    `SELECT character_maximum_length AS n
       FROM information_schema.columns
      WHERE table_name = 'gallery_bundles' AND column_name = 'status'`
  );
  const max = Number(col.rows[0].n);
  assert.ok(max > 0, 'status should be a bounded varchar');

  const tooLong = SUB.ALL.filter((s) => s.length > max);
  assert.deepEqual(tooLong, [],
    `these statuses do not fit in varchar(${max}): ${tooLong.join(', ')}`);
});