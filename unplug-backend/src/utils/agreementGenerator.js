const crypto = require('crypto');
const pool = require('../db');
const uploads = require('../routes/uploads');

const WORKFLOW_STATUSES = ['draft','sent','in_progress','submitted','under_review','signed','completed','archived'];
const APPROVAL_STATUSES = ['draft','legal_review','approved','published','retired'];
const PARTY_B_TYPES = ['individual','business'];
const SIGNATURE_TYPES = ['typed','drawn','uploaded'];
const ACCESS_METHODS = ['private_link','member_login','both'];
const SIGNING_ORDERS = ['party_b_first','party_a_first'];
const MASTER_SECTIONS = [
  'agreement_identification',
  'party_a_business',
  'party_b_individual',
  'party_b_business',
  'scope',
  'financial_information',
  'rights_content_ip',
  'privacy_confidentiality',
  'risk_warranties_legal',
  'agreement_specific_questions',
  'declarations_signatures',
];

function trim(value, max = 5000) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim().slice(0, max);
  return out || null;
}

function validEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || ''));
}

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(fallback)) return Array.isArray(value) ? value : fallback;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function codeHash(submissionId, code) {
  const secret = process.env.JWT_SECRET || process.env.AGREEMENT_OTP_SECRET || 'agreement-otp';
  return crypto.createHash('sha256').update(`${submissionId}:${code}:${secret}`).digest('hex');
}

function currentActor(req) {
  return {
    userId: req && req.user ? req.user.id : null,
    role: req && req.user ? req.user.role : 'guest',
    ip: req ? (req.ip || null) : null,
    userAgent: req ? trim(req.get && req.get('user-agent'), 1000) : null,
  };
}

async function audit({ agreementId = null, submissionId = null, action, fromStatus = null,
  toStatus = null, reason = null, details = {}, req = null, client = pool }) {
  const actor = currentActor(req);
  await client.query(
    `INSERT INTO agreement_audit_log
       (agreement_id,submission_id,actor_user_id,actor_role,action,from_status,to_status,
        reason,details,ip,user_agent)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [agreementId, submissionId, actor.userId, actor.role, action, fromStatus, toStatus,
      trim(reason, 5000), JSON.stringify(safeJson(details, {})), actor.ip, actor.userAgent]
  );
}

async function nextReference(client = pool, year = new Date().getFullYear()) {
  const r = await client.query(
    `INSERT INTO agreement_reference_sequences(year_value,last_value,updated_at)
     VALUES($1,1,now())
     ON CONFLICT(year_value) DO UPDATE
       SET last_value=agreement_reference_sequences.last_value+1,updated_at=now()
     RETURNING last_value`, [year]
  );
  return `UNP-AGR-${year}-${String(r.rows[0].last_value).padStart(4, '0')}`;
}

async function getFormDefinition(agreementId, client = pool) {
  const formResult = await client.query('SELECT * FROM agreement_forms WHERE id=$1', [agreementId]);
  if (!formResult.rowCount) return null;
  const [fields, clauses, items] = await Promise.all([
    client.query('SELECT * FROM agreement_fields WHERE agreement_id=$1 ORDER BY position,id', [agreementId]),
    client.query(`SELECT c.*,b.name AS block_name,b.body_html AS block_body_html
                    FROM agreement_form_clauses c
                    LEFT JOIN agreement_clause_blocks b ON b.id=c.clause_block_id
                   WHERE c.agreement_id=$1 ORDER BY c.position,c.id`, [agreementId]),
    client.query('SELECT * FROM agreement_form_items WHERE agreement_id=$1 ORDER BY position,id', [agreementId]),
  ]);
  return { form: formResult.rows[0], fields: fields.rows, clauses: clauses.rows, items: items.rows };
}

function snapshotFromDefinition(definition) {
  const { form, fields, clauses, items } = definition;
  return {
    form: { ...form },
    fields: fields.map((x) => ({ ...x })),
    clauses: clauses.map((x) => ({ ...x })),
    items: items.map((x) => ({ ...x })),
  };
}

async function ensureVersionSnapshot(agreementId, userId, client = pool, approvalStatus = null) {
  const definition = await getFormDefinition(agreementId, client);
  if (!definition) return null;
  const snapshot = snapshotFromDefinition(definition);
  const status = approvalStatus || definition.form.approval_status || 'draft';
  await client.query(
    `INSERT INTO agreement_form_versions
       (agreement_id,version,snapshot,approval_status,created_by,reviewed_by,reviewed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(agreement_id,version) DO NOTHING`,
    [agreementId, definition.form.version, JSON.stringify(snapshot), status, userId || null,
      definition.form.reviewed_by || null, definition.form.reviewed_at || null]
  );
  const r = await client.query(
    'SELECT * FROM agreement_form_versions WHERE agreement_id=$1 AND version=$2',
    [agreementId, definition.form.version]
  );
  return r.rows[0] || null;
}

async function latestApprovedVersion(agreementId, client = pool) {
  const r = await client.query(
    `SELECT * FROM agreement_form_versions
      WHERE agreement_id=$1 AND approval_status IN ('published','approved')
      ORDER BY version DESC LIMIT 1`, [agreementId]
  );
  return r.rows[0] || null;
}

function conditionMatches(condition, values) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition) || !condition.field) return true;
  const actual = values ? values[condition.field] : undefined;
  const op = String(condition.operator || 'equals').toLowerCase();
  const expected = condition.value;
  if (op === 'equals') return String(actual ?? '') === String(expected ?? '');
  if (op === 'not_equals') return String(actual ?? '') !== String(expected ?? '');
  if (op === 'truthy') return !!actual;
  if (op === 'falsy') return !actual;
  if (op === 'in') return Array.isArray(expected) && expected.map(String).includes(String(actual ?? ''));
  if (op === 'not_in') return Array.isArray(expected) && !expected.map(String).includes(String(actual ?? ''));
  return false;
}

function fieldApplies(field, partyBType, values) {
  const scope = String(field.party_scope || '').toLowerCase();
  if (scope === 'party_b_individual' && partyBType !== 'individual') return false;
  if (scope === 'party_b_business' && partyBType !== 'business') return false;
  if (scope === 'party_a') return false;
  if (field.sensitive_type === 'identity_document' && !field.popia_enabled) return false;
  return conditionMatches(field.condition_json, values);
}

function itemApplies(item, values) {
  return conditionMatches(item.condition_json, values);
}

function clauseApplies(clause, values) {
  if (clause.excluded) return false;
  return conditionMatches(clause.condition_json, values);
}

function publicField(field) {
  return {
    id: field.id,
    key: field.field_key,
    kind: field.kind,
    label: field.label,
    placeholder: field.placeholder,
    help: field.help,
    required: !!field.required,
    options: Array.isArray(field.options) ? field.options : [],
    maxLength: field.max_length,
    sectionKey: field.section_key,
    partyScope: field.party_scope,
    condition: safeJson(field.condition_json, {}),
    sensitiveType: field.sensitive_type,
    popia: field.sensitive_type === 'identity_document' && field.popia_enabled ? {
      enabled: true,
      purpose: field.popia_purpose,
      retentionPeriod: field.popia_retention,
      access: field.popia_access,
      acknowledgementRequired: !!field.popia_ack_required,
    } : { enabled: false },
  };
}

function publicDefinitionFromSnapshot(snapshot, partyBType = null, values = {}) {
  const form = snapshot.form || {};
  const chosen = partyBType || (PARTY_B_TYPES.includes(form.signer_type) ? form.signer_type : null);
  const fields = (snapshot.fields || []).filter((f) => fieldApplies(f, chosen, values)).map(publicField);
  const clauses = (snapshot.clauses || []).filter((c) => clauseApplies(c, values)).map((c) => ({
    id: c.id,
    title: c.title || c.block_name || null,
    bodyHtml: c.body_html || c.block_body_html || '',
    condition: safeJson(c.condition_json, {}),
  }));
  const items = (snapshot.items || []).filter((i) => i.visibility !== 'internal_admin' && itemApplies(i, values)).map((i) => ({
    id: i.id,
    kind: i.kind,
    label: i.label,
    help: i.help,
    visibility: i.visibility,
    required: !!i.required || i.visibility === 'party_b_required',
    condition: safeJson(i.condition_json, {}),
  }));
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    category: form.category,
    version: form.version,
    signerType: form.signer_type,
    partyBType: chosen,
    accessMethod: form.access_method || 'private_link',
    signingOrder: form.signing_order || 'party_b_first',
    rules: form.rules,
    terms: form.terms,
    declarations: Array.isArray(form.declarations) ? form.declarations : [],
    fields,
    clauses,
    items,
    financial: {
      amount: form.amount === null || form.amount === undefined ? null : Number(form.amount),
      paymentMode: form.payment_mode || 'none',
    },
    service: {
      scope: form.service_scope,
      name: form.service_name,
      description: form.service_description,
      reference: form.service_reference,
      clientName: form.client_name,
    },
  };
}

function validatePopia(field) {
  if (field.sensitiveType !== 'identity_document' && field.sensitive_type !== 'identity_document') return null;
  const enabled = field.popiaEnabled !== undefined ? !!field.popiaEnabled : !!field.popia_enabled;
  if (!enabled) return null;
  const purpose = trim(field.popiaPurpose !== undefined ? field.popiaPurpose : field.popia_purpose, 5000);
  const retention = trim(field.popiaRetention !== undefined ? field.popiaRetention : field.popia_retention, 2000);
  const access = trim(field.popiaAccess !== undefined ? field.popiaAccess : field.popia_access, 2000);
  if (!purpose || !retention || !access) {
    const err = new Error('ID/passport collection requires a purpose, retention period and access description.');
    err.statusCode = 400;
    throw err;
  }
  return { purpose, retention, access };
}

function validateAnswers(snapshot, partyBType, suppliedAnswers, declarationsAccepted = {}) {
  const answers = safeJson(suppliedAnswers, {});
  const clean = {};
  const activeFields = (snapshot.fields || []).filter((f) => fieldApplies(f, partyBType, answers));
  for (const field of activeFields) {
    let value = answers[field.field_key];
    if (field.kind === 'checkbox') value = value === true || value === 'true' || value === 'on';
    else if (value !== null && value !== undefined) value = trim(value, Math.min(Number(field.max_length) || 5000, 10000));
    if (field.required && (value === null || value === undefined || value === '' || value === false)) {
      const err = new Error(`“${field.label}” is required.`); err.statusCode = 400; throw err;
    }
    if (value && field.kind === 'email' && !validEmail(value)) {
      const err = new Error(`“${field.label}” does not look like an email address.`); err.statusCode = 400; throw err;
    }
    if (value && (field.kind === 'select' || field.kind === 'radio')) {
      const options = Array.isArray(field.options) ? field.options : [];
      if (options.length && !options.includes(value)) {
        const err = new Error(`“${value}” is not one of the choices for “${field.label}”.`); err.statusCode = 400; throw err;
      }
    }
    if (field.sensitive_type === 'identity_document') {
      if (!field.popia_enabled) continue;
      validatePopia(field);
      if (field.popia_ack_required && declarationsAccepted[`popia:${field.field_key}`] !== true) {
        const err = new Error(`Please acknowledge the POPIA collection notice for “${field.label}”.`); err.statusCode = 400; throw err;
      }
    }
    clean[field.field_key] = value;
  }
  const declarations = Array.isArray(snapshot.form && snapshot.form.declarations) ? snapshot.form.declarations : [];
  for (const declaration of declarations) {
    const id = String((declaration && (declaration.id || declaration.key)) || '').trim();
    if (declaration && declaration.required !== false && id && declarationsAccepted[id] !== true) {
      const err = new Error(`Please accept the declaration: ${declaration.text || declaration.label || id}`); err.statusCode = 400; throw err;
    }
  }
  return clean;
}

async function storePrivateSignature(dataUrl, label = 'signature') {
  if (!dataUrl) return null;
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!match) {
    const err = new Error('Uploaded or drawn signatures must be PNG, JPEG or WebP images.'); err.statusCode = 400; throw err;
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 400 * 1024) {
    const err = new Error('Signature image must be smaller than 400 KB.'); err.statusCode = 400; throw err;
  }
  if (!uploads.r2PrivateConfigured) {
    const err = new Error('Private signature storage is unavailable.'); err.statusCode = 503; throw err;
  }
  const ext = match[1] === 'jpg' ? 'jpeg' : match[1];
  return uploads.uploadPrivateBuffer(buffer,
    `agreement-generator-${label}-${crypto.randomBytes(8).toString('hex')}.${ext}`, `image/${ext}`);
}

async function submissionByToken(token, client = pool) {
  if (!token || String(token).length < 20) return null;
  const r = await client.query('SELECT * FROM agreement_submissions WHERE signing_token=$1', [String(token)]);
  return r.rows[0] || null;
}

function assertAccessMethod(submission, req) {
  const method = submission.access_method || 'private_link';
  if (method === 'member_login') {
    if (!req.user) {
      const err = new Error('Sign in to your Unplug account to continue this agreement.'); err.statusCode = 401; throw err;
    }
    if (submission.user_id && Number(submission.user_id) !== Number(req.user.id)) {
      const err = new Error('This agreement is assigned to another member account.'); err.statusCode = 403; throw err;
    }
  }
  if (submission.locked_at) {
    const err = new Error('This submitted agreement is locked. An administrator must reopen it before it can be changed.'); err.statusCode = 423; throw err;
  }
}

async function canStaffAccessSubmission(req, submissionId, client = pool) {
  if (!req.user) return false;
  if (req.user.role === 'admin') return true;
  if (req.user.role !== 'staff') return false;
  const { hasPermission } = require('./staffPermissions');
  if (!(await hasPermission(req.user.id, 'agreements.manage'))) return false;
  const assigned = await client.query(
    'SELECT 1 FROM agreement_submission_assignments WHERE submission_id=$1 AND user_id=$2',
    [submissionId, req.user.id]
  );
  return assigned.rowCount > 0;
}

module.exports = {
  WORKFLOW_STATUSES, APPROVAL_STATUSES, PARTY_B_TYPES, SIGNATURE_TYPES,
  ACCESS_METHODS, SIGNING_ORDERS, MASTER_SECTIONS,
  trim, validEmail, safeJson, randomToken, codeHash, audit, nextReference,
  getFormDefinition, snapshotFromDefinition, ensureVersionSnapshot, latestApprovedVersion,
  conditionMatches, fieldApplies, itemApplies, clauseApplies, publicDefinitionFromSnapshot,
  validatePopia, validateAnswers, storePrivateSignature, submissionByToken,
  assertAccessMethod, canStaffAccessSubmission,
};
