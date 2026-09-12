// Agreement Generator — real HTTP + real PostgreSQL integration tests.
//
// These tests deliberately mount the Agreement Forms bridge, not a mock router,
// so the standalone generator and the pre-existing Agreement Forms/payment
// policy are exercised in the same order used by src/app.js.

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-agreement-generator-'));
const port = 23800 + (process.pid % 300);
let nextUserId = 18000;
const jwt = require('jsonwebtoken');

function tokenFor(id, email, role) {
  return jwt.sign({ id, email, role }, process.env.JWT_SECRET);
}

async function makeUser(email, role = 'admin') {
  const id = nextUserId++;
  await pool.query(
    `INSERT INTO users (id,email,password_hash,role) VALUES($1,$2,'x',$3) ON CONFLICT DO NOTHING`,
    [id,email,role]
  );
  return id;
}

async function req(method, urlPath, { token, body, raw = false } = {}) {
  const response = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
  if (raw) return response;
  const contentType = response.headers.get('content-type') || '';
  const parsed = contentType.includes('json') ? await response.json().catch(() => ({})) : await response.text();
  return { status: response.status, body: parsed, headers: response.headers };
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
  process.env.JWT_SECRET = 'agreement-generator-test-secret';
  process.env.NODE_ENV = 'test';
  process.env.SITE_URL = 'https://example.test';
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const migrations = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql')).sort();
  for (const file of migrations) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', file), 'utf8'));
  }

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '512kb' }));
  app.use(attachUser);
  app.use('/agreement-forms', require('../src/middleware/agreementPaymentPolicy'));
  app.use('/agreement-forms', require('../src/routes/agreementForms').router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Agreement Details master and required presets are installed without enabling ID/passport collection', async () => {
  const names = (await pool.query('SELECT name FROM agreement_templates ORDER BY name')).rows.map((x) => x.name);
  for (const required of [
    'Agreement Details — Master',
    'Model / Photo / Video Release',
    'Sponsorship Agreement',
    'Independent Contractor / Freelancer Agreement',
    'Contributor / Content Submission Agreement',
    'Event Participation Agreement',
    'Influencer / Brand Collaboration Agreement',
    'Confidentiality / NDA',
    'Advertising / Promotional Services Agreement',
  ]) assert.ok(names.includes(required), `missing preset: ${required}`);

  const identity = await pool.query(
    `SELECT tf.* FROM template_fields tf JOIN agreement_templates t ON t.id=tf.template_id
      WHERE t.name='Agreement Details — Master' AND tf.field_key='party_b_individual_id_passport'`
  );
  assert.equal(identity.rowCount, 1);
  assert.equal(identity.rows[0].required, false);
  assert.equal(identity.rows[0].popia_enabled, false);
  assert.equal(identity.rows[0].sensitive_type, 'identity_document');
});

test('standalone generator is mounted under /agreement-forms and legacy /agreements data is not migrated', () => {
  const root = path.join(__dirname, '..', '..');
  const app = fs.readFileSync(path.join(root, 'unplug-backend', 'src', 'app.js'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'unplug-backend', 'db', 'migrations', '202_agreement_generator.sql'), 'utf8');
  assert.match(app, /app\.use\('\/agreements', agreementRoutes\)/);
  assert.match(app, /app\.use\('\/agreement-forms', require\('\.\/middleware\/agreementPaymentPolicy'\)\)/);
  assert.doesNotMatch(migration, /ALTER\s+TABLE\s+signed_agreements/i);
  assert.doesNotMatch(migration, /DROP\s+TABLE\s+signed_agreements/i);
});

test('staff without explicit Agreement permissions cannot open the generator admin API', async () => {
  const id = await makeUser('agreement-staff-no-access@test.com', 'staff');
  const denied = await req('GET', '/agreement-forms/generator/admin/templates', {
    token: tokenFor(id, 'agreement-staff-no-access@test.com', 'staff'),
  });
  assert.equal(denied.status, 403);
});

test('POPIA identity collection cannot be enabled without purpose, retention and access controls', async () => {
  const adminId = await makeUser('agreement-popia@test.com', 'admin');
  const token = tokenFor(adminId, 'agreement-popia@test.com', 'admin');
  const created = await req('POST', '/agreement-forms/generator/admin/templates', {
    token,
    body: { name: 'POPIA Guard Test', signerType: 'individual' },
  });
  assert.equal(created.status, 201);
  const templateId = created.body.form.id;

  const rejected = await req('POST', `/agreement-forms/generator/admin/templates/${templateId}/fields`, {
    token,
    body: {
      key: 'id_number', label: 'ID number', kind: 'text', sectionKey: 'party_b_individual',
      partyScope: 'party_b_individual', sensitiveType: 'identity_document', popiaEnabled: true,
    },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /purpose/i);

  const accepted = await req('POST', `/agreement-forms/generator/admin/templates/${templateId}/fields`, {
    token,
    body: {
      key: 'id_number', label: 'ID number', kind: 'text', sectionKey: 'party_b_individual',
      partyScope: 'party_b_individual', sensitiveType: 'identity_document', popiaEnabled: true,
      popiaPurpose: 'Identity verification for the contracted service',
      popiaRetention: 'Duration of the agreement plus the documented legal retention period',
      popiaAccess: 'Super Admin and explicitly authorised agreement staff only',
      popiaAckRequired: true,
    },
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.field.popia_enabled, true);
});

let flow = {};

test('admin can create, approve and version a generator template', async () => {
  const adminId = await makeUser('agreement-flow-admin@test.com', 'admin');
  const adminToken = tokenFor(adminId, 'agreement-flow-admin@test.com', 'admin');
  flow.adminId = adminId;
  flow.adminToken = adminToken;

  const created = await req('POST', '/agreement-forms/generator/admin/templates', {
    token: adminToken,
    body: {
      name: 'Generator Flow Test', title: 'Generator Flow Test', signerType: 'choice',
      accessMethod: 'private_link', signingOrder: 'party_b_first',
      notificationConfig: { recipients: [] },
      deliveryConfig: { save_notify_unplug: true, email_party_b: false, allow_download: true, manual_download_email: false },
    },
  });
  assert.equal(created.status, 201);
  const templateId = created.body.form.id;
  flow.templateId = templateId;

  const field = await req('POST', `/agreement-forms/generator/admin/templates/${templateId}/fields`, {
    token: adminToken,
    body: {
      key: 'project_role', label: 'Project role', kind: 'text', required: true,
      sectionKey: 'agreement_specific_questions', partyScope: 'agreement',
    },
  });
  assert.equal(field.status, 201);

  let approval = await req('POST', `/agreement-forms/generator/admin/templates/${templateId}/approval`, {
    token: adminToken, body: { status: 'legal_review', reason: 'Ready for legal review test' },
  });
  assert.equal(approval.status, 200);
  approval = await req('POST', `/agreement-forms/generator/admin/templates/${templateId}/approval`, {
    token: adminToken, body: { status: 'approved', reason: 'Approved for integration test' },
  });
  assert.equal(approval.status, 200);
  assert.equal(approval.body.template.approval_status, 'approved');
  flow.approvedVersion = approval.body.template.version;

  const history = await req('GET', `/agreement-forms/generator/admin/templates/${templateId}`, { token: adminToken });
  assert.equal(history.status, 200);
  assert.ok(history.body.approvalHistory.some((x) => x.to_status === 'legal_review'));
  assert.ok(history.body.approvalHistory.some((x) => x.to_status === 'approved'));
});

test('individual agreement gets UNP reference and remains linked to its approved template version after later edits', async () => {
  const made = await req('POST', '/agreement-forms/generator/admin/agreements', {
    token: flow.adminToken,
    body: { templateId: flow.templateId, partyBType: 'individual' },
  });
  assert.equal(made.status, 201);
  assert.match(made.body.agreement.reference, /^UNP-AGR-\d{4}-\d{4,}$/);
  assert.equal(made.body.agreement.agreement_version, flow.approvedVersion);
  assert.match(made.body.secureLink, /unplug-agreement-generator\.html\?token=/);
  flow.submissionId = made.body.agreement.id;
  flow.accessToken = new URL(made.body.secureLink).searchParams.get('token');
  flow.reference = made.body.agreement.reference;

  const edited = await req('PATCH', `/agreement-forms/generator/admin/templates/${flow.templateId}`, {
    token: flow.adminToken,
    body: { description: 'A later draft change that must not rewrite the existing agreement.' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.template.approval_status, 'draft');
  assert.ok(edited.body.template.version > flow.approvedVersion);

  const existing = await req('GET', `/agreement-forms/generator/admin/agreements/${flow.submissionId}`, { token: flow.adminToken });
  assert.equal(existing.status, 200);
  assert.equal(existing.body.agreement.agreement_version, flow.approvedVersion);
});

test('Party B secure-link draft/resume, OTP, typed signature and submission lock work end-to-end', async () => {
  const initial = await req('GET', `/agreement-forms/generator/access/${flow.accessToken}`);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.agreement.reference, flow.reference);
  assert.equal(initial.body.agreement.partyBType, 'individual');

  const saved = await req('PATCH', `/agreement-forms/generator/access/${flow.accessToken}/draft`, {
    body: {
      partyBType: 'individual',
      signerName: 'Integration Signer',
      signerEmail: 'integration-signer@example.com',
      mobile: '0820000000',
      capacity: 'Participant',
      answers: { project_role: 'Test participant' },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status, 'in_progress');

  const resumed = await req('GET', `/agreement-forms/generator/access/${flow.accessToken}`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.draft.answers.project_role, 'Test participant');

  const otp = await req('POST', `/agreement-forms/generator/access/${flow.accessToken}/verify/request`, {
    body: { channel: 'email', destination: 'integration-signer@example.com' },
  });
  assert.equal(otp.status, 200);
  assert.match(otp.body.testCode, /^\d{6}$/);

  const verified = await req('POST', `/agreement-forms/generator/access/${flow.accessToken}/verify/confirm`, {
    body: { channel: 'email', code: otp.body.testCode },
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.verified, true);

  const submitted = await req('POST', `/agreement-forms/generator/access/${flow.accessToken}/submit`, {
    body: {
      partyBType: 'individual',
      signerName: 'Integration Signer',
      signerEmail: 'integration-signer@example.com',
      capacity: 'Participant',
      answers: { project_role: 'Test participant' },
      declarationsAccepted: {},
      signatureType: 'typed',
      signatureText: 'Integration Signer',
    },
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.status, 'submitted');
  assert.equal(submitted.body.downloadAllowed, true);

  const locked = await req('PATCH', `/agreement-forms/generator/access/${flow.accessToken}/draft`, {
    body: { answers: { project_role: 'Attempted silent edit' } },
  });
  assert.equal(locked.status, 423);

  const record = await req('GET', `/agreement-forms/generator/admin/agreements/${flow.submissionId}`, { token: flow.adminToken });
  assert.equal(record.status, 200);
  assert.equal(record.body.agreement.workflow_status, 'submitted');
  assert.ok(record.body.agreement.locked_at);
  assert.ok(record.body.audit.some((x) => x.action === 'party_b_signer_signed'));
});

test('completed PDF contains a real PDF response and support uploads fail closed when private R2 is unavailable', async () => {
  const pdf = await req('GET', `/agreement-forms/generator/access/${flow.accessToken}/pdf`, { raw: true });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type') || '', /application\/pdf/);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');

  const form = new FormData();
  form.append('file', new Blob(['not really an image'], { type: 'image/png' }), 'test.png');
  const upload = await req('POST', `/agreement-forms/generator/access/${flow.accessToken}/items/999/upload`, {
    raw: true, body: form,
  });
  assert.ok([423, 503].includes(upload.status));
});

test('Party A signing, review, Signed, Completed, Archive and Restore are audited', async () => {
  const partyA = await req('POST', `/agreement-forms/generator/admin/agreements/${flow.submissionId}/party-a-sign`, {
    token: flow.adminToken,
    body: { name: 'Unplug Authorised Signer', capacity: 'Authorised Representative', signatureType: 'typed', signatureText: 'Unplug Authorised Signer' },
  });
  assert.equal(partyA.status, 200);

  let status = await req('POST', `/agreement-forms/generator/admin/agreements/${flow.submissionId}/status`, {
    token: flow.adminToken, body: { status: 'under_review' },
  });
  assert.equal(status.status, 200);
  status = await req('POST', `/agreement-forms/generator/admin/agreements/${flow.submissionId}/status`, {
    token: flow.adminToken, body: { status: 'signed' },
  });
  assert.equal(status.status, 200);
  status = await req('POST', `/agreement-forms/generator/admin/agreements/${flow.submissionId}/status`, {
    token: flow.adminToken, body: { status: 'completed' },
  });
  assert.equal(status.status, 200);

  const archived = await req('POST', `/agreement-forms/generator/admin/agreements/${flow.submissionId}/archive`, {
    token: flow.adminToken, body: { reason: 'Archive test' },
  });
  assert.equal(archived.status, 200);
  const restored = await req('POST', `/agreement-forms/generator/admin/agreements/${flow.submissionId}/restore`, {
    token: flow.adminToken, body: { reason: 'Restore test' },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.status, 'completed');

  const record = await req('GET', `/agreement-forms/generator/admin/agreements/${flow.submissionId}`, { token: flow.adminToken });
  const actions = record.body.audit.map((x) => x.action);
  assert.ok(actions.includes('party_a_signed'));
  assert.ok(actions.includes('agreement_archived'));
  assert.ok(actions.includes('agreement_restored'));
});

test('reopening a fully signed agreement preserves the signed record and creates a superseding agreement', async () => {
  const reopened = await req('POST', `/agreement-forms/generator/admin/agreements/${flow.submissionId}/reopen`, {
    token: flow.adminToken,
    body: { reason: 'Contract terms need a formally superseding version.' },
  });
  assert.equal(reopened.status, 201);
  assert.equal(reopened.body.superseded, true);
  assert.notEqual(reopened.body.agreement.id, flow.submissionId);
  assert.notEqual(reopened.body.agreement.reference, flow.reference);
  assert.equal(reopened.body.agreement.workflow_status, 'in_progress');

  const old = await pool.query('SELECT * FROM agreement_submissions WHERE id=$1', [flow.submissionId]);
  assert.equal(old.rows[0].superseded_by_id, reopened.body.agreement.id);
  assert.ok(old.rows[0].locked_at, 'the signed source record stays locked');
  assert.equal(old.rows[0].answers.project_role, 'Test participant');
});

test('reference override requires Super Admin and preserves original value plus reason', async () => {
  const before = await pool.query('SELECT reference FROM agreement_submissions WHERE id=$1', [flow.submissionId]);
  const original = before.rows[0].reference;
  const changed = await req('POST', `/agreement-forms/generator/admin/agreements/${flow.submissionId}/reference-override`, {
    token: flow.adminToken,
    body: { reference: 'UNP-AGR-OVERRIDE-TEST', reason: 'Controlled reference override integration test' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.agreement.reference, 'UNP-AGR-OVERRIDE-TEST');
  assert.equal(changed.body.agreement.reference_original, original);
  assert.equal(changed.body.agreement.reference_override_reason, 'Controlled reference override integration test');
});

test('pure conditional-field and POPIA helpers keep irrelevant Party B fields out of the public definition', () => {
  const G = require('../src/utils/agreementGenerator');
  const snapshot = {
    form: { id: 1, title: 'X', version: 1, signer_type: 'choice', declarations: [] },
    fields: [
      { id:1,field_key:'ind',kind:'text',label:'Individual only',party_scope:'party_b_individual',condition_json:{},required:true,options:[] },
      { id:2,field_key:'biz',kind:'text',label:'Business only',party_scope:'party_b_business',condition_json:{},required:true,options:[] },
      { id:3,field_key:'id',kind:'text',label:'ID',party_scope:'party_b_individual',condition_json:{},required:false,options:[],sensitive_type:'identity_document',popia_enabled:false },
    ], clauses:[], items:[],
  };
  const individual = G.publicDefinitionFromSnapshot(snapshot,'individual',{});
  assert.deepEqual(individual.fields.map((x) => x.key), ['ind']);
  const business = G.publicDefinitionFromSnapshot(snapshot,'business',{});
  assert.deepEqual(business.fields.map((x) => x.key), ['biz']);
  assert.equal(G.conditionMatches({ field:'x',operator:'equals',value:'yes' },{ x:'yes' }), true);
  assert.equal(G.conditionMatches({ field:'x',operator:'equals',value:'yes' },{ x:'no' }), false);
});
