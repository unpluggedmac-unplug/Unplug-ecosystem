const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole, requireSuperAdmin } = require('../middleware/auth');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const { sendEmail } = require('../utils/email');
const { generateAgreementDocument } = require('../utils/agreementDocument');
const uploads = require('./uploads');
const G = require('../utils/agreementGenerator');

const router = express.Router();

const STATUS_TRANSITIONS = {
  draft: ['sent', 'archived'],
  sent: ['in_progress', 'archived'],
  in_progress: ['submitted', 'archived'],
  submitted: ['under_review', 'archived'],
  under_review: ['signed', 'archived'],
  signed: ['completed', 'archived'],
  completed: ['archived'],
  archived: [],
};

const APPROVAL_TRANSITIONS = {
  draft: ['legal_review'],
  legal_review: ['approved', 'draft'],
  approved: ['published', 'legal_review'],
  published: ['retired'],
  retired: ['draft'],
};

function cleanRichText(value, max = 100000) {
  const raw = G.trim(value, max) || '';
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

function asObject(v) { return G.safeJson(v, {}); }
function asArray(v) { return G.safeJson(v, []); }

async function loadSubmission(id, client = pool) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const r = await client.query('SELECT * FROM agreement_submissions WHERE id=$1', [n]);
  return r.rows[0] || null;
}

async function requireInstanceAccess(req, res, next) {
  try {
    const submission = await loadSubmission(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Agreement record not found.' });
    if (!(await G.canStaffAccessSubmission(req, submission.id))) {
      return res.status(403).json({ error: 'This agreement is not assigned to you.' });
    }
    req.agreementSubmission = submission;
    next();
  } catch (err) { next(err); }
}

async function ensureFormShortCode(formId, client = pool) {
  const current = await client.query('SELECT short_code FROM agreement_forms WHERE id=$1', [formId]);
  if (!current.rowCount) return null;
  if (current.rows[0].short_code) return current.rows[0].short_code;
  for (;;) {
    const code = G.randomToken(6).slice(0, 10).toUpperCase();
    try {
      await client.query('UPDATE agreement_forms SET short_code=$2 WHERE id=$1 AND short_code IS NULL', [formId, code]);
      const check = await client.query('SELECT short_code FROM agreement_forms WHERE id=$1', [formId]);
      return check.rows[0].short_code;
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }
}

async function versionSnapshotById(id, client = pool) {
  if (!id) return null;
  const r = await client.query('SELECT * FROM agreement_form_versions WHERE id=$1', [id]);
  return r.rows[0] || null;
}

async function snapshotForSubmission(submission, client = pool) {
  const v = await versionSnapshotById(submission.template_version_id, client);
  if (v && v.snapshot) return v.snapshot;
  if (submission.definition_at_signing && Object.keys(submission.definition_at_signing).length) {
    const definition = submission.definition_at_signing;
    if (definition.form) return definition;
    return { form: definition, fields: definition.fields || [], clauses: [], items: [] };
  }
  const current = await G.getFormDefinition(submission.agreement_id, client);
  return current ? G.snapshotFromDefinition(current) : null;
}

async function bumpTemplateVersion(agreementId, req, client, reason = 'Template edited') {
  const before = await G.getFormDefinition(agreementId, client);
  if (!before) return null;
  await G.ensureVersionSnapshot(agreementId, req.user && req.user.id, client);
  const oldStatus = before.form.approval_status || 'draft';
  const r = await client.query(
    `UPDATE agreement_forms
        SET version=version+1,approval_status='draft',published=false,status='draft',
            reviewed_by=NULL,reviewed_at=NULL,approved_by=NULL,approved_at=NULL,
            published_at=NULL,retired_at=NULL,updated_at=now()
      WHERE id=$1 RETURNING *`, [agreementId]
  );
  await client.query(
    `INSERT INTO agreement_template_approval_history
       (agreement_id,version,from_status,to_status,reviewer_id,reason)
     VALUES($1,$2,$3,'draft',$4,$5)`,
    [agreementId, r.rows[0].version, oldStatus, req.user.id, reason]
  );
  await G.audit({ agreementId, action: 'template_new_version', fromStatus: oldStatus,
    toStatus: 'draft', reason, details: { version: r.rows[0].version }, req, client });
  return r.rows[0];
}

async function approvedVersionForCreate(formId, client = pool) {
  let version = await G.latestApprovedVersion(formId, client);
  if (version) return version;
  const f = await client.query('SELECT * FROM agreement_forms WHERE id=$1', [formId]);
  if (!f.rowCount || !['approved','published'].includes(f.rows[0].approval_status)) return null;
  await G.ensureVersionSnapshot(formId, null, client, f.rows[0].approval_status);
  version = await G.latestApprovedVersion(formId, client);
  return version;
}

async function partyBItemValues(submissionId, client = pool) {
  const r = await client.query(
    `SELECT si.*,fi.kind,fi.label,fi.visibility,fi.required,fi.condition_json
       FROM agreement_submission_items si
       JOIN agreement_form_items fi ON fi.id=si.form_item_id
      WHERE si.submission_id=$1`, [submissionId]
  );
  return r.rows;
}

async function validateRequiredItems(snapshot, values, submissionId, client = pool) {
  const submitted = await partyBItemValues(submissionId, client);
  const byId = new Map(submitted.map((x) => [Number(x.form_item_id), x]));
  for (const item of (snapshot.items || [])) {
    if (item.visibility === 'internal_admin' || !G.itemApplies(item, values)) continue;
    const required = item.required || item.visibility === 'party_b_required';
    if (!required) continue;
    const value = byId.get(Number(item.id));
    if (!value || (item.kind === 'upload' ? !value.upload_url : !value.note_text)) {
      const err = new Error(`“${item.label}” is required.`); err.statusCode = 400; throw err;
    }
  }
}

async function notifySubmission(submission, snapshot, pdf, partyBEmail) {
  const form = snapshot.form || {};
  const notify = asObject(submission.notification_config && Object.keys(submission.notification_config).length
    ? submission.notification_config : form.notification_config);
  const delivery = asObject(submission.delivery_config && Object.keys(submission.delivery_config).length
    ? submission.delivery_config : form.delivery_config);
  const recipients = Array.isArray(notify.recipients) ? [...new Set(notify.recipients.filter(G.validEmail))] : [];
  for (const to of recipients) {
    await sendEmail({
      to,
      subject: `Agreement submitted — ${submission.reference}`,
      text: `A completed agreement has been submitted.\n\n${form.title || submission.title_at_signing || 'Agreement'}\nReference: ${submission.reference}\nVersion: v${submission.agreement_version}`,
      attachments: pdf ? [{ filename: `${submission.reference}.pdf`, content: pdf }] : undefined,
    });
  }
  if (delivery.email_party_b && G.validEmail(partyBEmail)) {
    await sendEmail({
      to: partyBEmail,
      subject: `${form.title || 'Agreement'} — ${submission.reference}`,
      text: `Thank you. Your agreement has been submitted to Unplug.\nReference: ${submission.reference}\nVersion: v${submission.agreement_version}`,
      attachments: pdf ? [{ filename: `${submission.reference}.pdf`, content: pdf }] : undefined,
    });
  }
}

async function renderPdfForSubmission(submission, client = pool) {
  const snapshot = await snapshotForSubmission(submission, client);
  if (!snapshot) return null;
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  return generateAgreementDocument({ submission, fields, client });
}

// ---------------------------------------------------------------------------
// Module metadata — used by the Control Centre builder.
// ---------------------------------------------------------------------------
router.get('/generator/meta', requireRole('admin'), (req, res) => {
  res.json({
    masterSections: G.MASTER_SECTIONS,
    workflowStatuses: G.WORKFLOW_STATUSES,
    approvalStatuses: G.APPROVAL_STATUSES,
    partyBTypes: G.PARTY_B_TYPES,
    accessMethods: G.ACCESS_METHODS,
    signingOrders: G.SIGNING_ORDERS,
    signatureTypes: G.SIGNATURE_TYPES,
    noteUploadVisibility: ['internal_admin','party_b_visible','party_b_required'],
  });
});

// ---------------------------------------------------------------------------
// MASTER TEMPLATE BUILDER
// ---------------------------------------------------------------------------
router.get('/generator/admin/templates', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT a.*,
              (SELECT count(*)::int FROM agreement_fields f WHERE f.agreement_id=a.id) field_count,
              (SELECT count(*)::int FROM agreement_form_clauses c WHERE c.agreement_id=a.id) clause_count,
              (SELECT count(*)::int FROM agreement_form_items i WHERE i.agreement_id=a.id) item_count,
              (SELECT max(v.version) FROM agreement_form_versions v
                WHERE v.agreement_id=a.id AND v.approval_status IN ('approved','published')) latest_approved_version
         FROM agreement_forms a
        ORDER BY a.updated_at DESC,a.id DESC`
    );
    res.json({ templates: r.rows });
  } catch (err) { next(err); }
});

router.get('/generator/admin/templates/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const d = await G.getFormDefinition(req.params.id);
    if (!d) return res.status(404).json({ error: 'Agreement template not found.' });
    const history = await pool.query(
      `SELECT h.*,u.full_name reviewer_name,u.email reviewer_email
         FROM agreement_template_approval_history h LEFT JOIN users u ON u.id=h.reviewer_id
        WHERE h.agreement_id=$1 ORDER BY h.created_at DESC,h.id DESC`, [req.params.id]
    );
    res.json({ ...d, approvalHistory: history.rows });
  } catch (err) { next(err); }
});

router.patch('/generator/admin/templates/:id', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await G.getFormDefinition(req.params.id, client);
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agreement template not found.' }); }
    const body = req.body || {};
    const signerType = body.signerType === undefined ? current.form.signer_type : String(body.signerType);
    const accessMethod = body.accessMethod === undefined ? current.form.access_method : String(body.accessMethod);
    const signingOrder = body.signingOrder === undefined ? current.form.signing_order : String(body.signingOrder);
    if (!['individual','business','choice'].includes(signerType)) throw Object.assign(new Error('Party B type must be Individual, Business or Choice.'), { statusCode: 400 });
    if (!G.ACCESS_METHODS.includes(accessMethod)) throw Object.assign(new Error('Invalid access method.'), { statusCode: 400 });
    if (!G.SIGNING_ORDERS.includes(signingOrder)) throw Object.assign(new Error('Invalid signing order.'), { statusCode: 400 });
    await bumpTemplateVersion(current.form.id, req, client, 'Agreement template details changed');
    const r = await client.query(
      `UPDATE agreement_forms SET
         name=COALESCE($2,name),title=COALESCE($3,title),description=$4,category=$5,
         signer_type=$6,rules=$7,terms=$8,post_signing_requirements=$9,
         service_scope=$10,service_name=$11,service_description=$12,service_reference=$13,client_name=$14,
         amount=$15,payment_mode=$16,min_age=$17,require_witness=$18,require_company_stamp=$19,
         access_method=$20,signing_order=$21,delivery_config=$22,notification_config=$23,
         declarations=$24,reminder_days=$25,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [current.form.id,
       body.name === undefined ? current.form.name : G.trim(body.name, 160),
       body.title === undefined ? current.form.title : G.trim(body.title, 220),
       body.description === undefined ? current.form.description : G.trim(body.description, 10000),
       body.category === undefined ? current.form.category : G.trim(body.category, 120), signerType,
       body.rules === undefined ? current.form.rules : cleanRichText(body.rules, 100000),
       body.terms === undefined ? current.form.terms : cleanRichText(body.terms, 100000),
       body.postSigningRequirements === undefined ? current.form.post_signing_requirements : cleanRichText(body.postSigningRequirements, 30000),
       body.serviceScope === undefined ? current.form.service_scope : (body.serviceScope === 'external' ? 'external' : 'website'),
       body.serviceName === undefined ? current.form.service_name : G.trim(body.serviceName, 200),
       body.serviceDescription === undefined ? current.form.service_description : G.trim(body.serviceDescription, 10000),
       body.serviceReference === undefined ? current.form.service_reference : G.trim(body.serviceReference, 160),
       body.clientName === undefined ? current.form.client_name : G.trim(body.clientName, 200),
       body.amount === undefined ? current.form.amount : (body.amount === '' || body.amount === null ? null : Math.max(0, Number(body.amount) || 0)),
       body.paymentMode === undefined ? current.form.payment_mode : (['none','before_sign','after_sign'].includes(body.paymentMode) ? body.paymentMode : 'none'),
       body.minAge === undefined ? current.form.min_age : (body.minAge === '' || body.minAge === null ? null : Math.max(0, Number(body.minAge) || 0)),
       body.requireWitness === undefined ? current.form.require_witness : !!body.requireWitness,
       body.requireCompanyStamp === undefined ? current.form.require_company_stamp : !!body.requireCompanyStamp,
       accessMethod, signingOrder,
       JSON.stringify(body.deliveryConfig === undefined ? current.form.delivery_config : asObject(body.deliveryConfig)),
       JSON.stringify(body.notificationConfig === undefined ? current.form.notification_config : asObject(body.notificationConfig)),
       JSON.stringify(body.declarations === undefined ? asArray(current.form.declarations) : asArray(body.declarations)),
       body.reminderDays === undefined ? current.form.reminder_days : (body.reminderDays === '' || body.reminderDays === null ? null : Math.max(0, Number(body.reminderDays) || 0))]
    );
    await client.query('COMMIT');
    res.json({ template: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

router.post('/generator/admin/templates/:id/approval', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await G.getFormDefinition(req.params.id, client);
    if (!d) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agreement template not found.' }); }
    const from = d.form.approval_status || 'draft';
    const to = String(req.body.status || '');
    if (!(APPROVAL_TRANSITIONS[from] || []).includes(to)) {
      throw Object.assign(new Error(`Template status cannot move from ${from} to ${to}.`), { statusCode: 400 });
    }
    if (to === 'approved' || to === 'published') {
      if (!(d.fields || []).length) throw Object.assign(new Error('Add at least one field before approval.'), { statusCode: 400 });
      for (const field of d.fields) G.validatePopia(field);
    }
    const sets = ['approval_status=$2','reviewed_by=$3','reviewed_at=now()','updated_at=now()'];
    const values = [d.form.id, to, req.user.id];
    if (to === 'approved') sets.push('approved_by=$3','approved_at=now()');
    if (to === 'published') sets.push("published=true","status='active'",'published_at=now()');
    if (to === 'retired') sets.push("published=false","status='archived'",'retired_at=now()');
    if (to === 'draft') sets.push("published=false","status='draft'");
    const r = await client.query(`UPDATE agreement_forms SET ${sets.join(',')} WHERE id=$1 RETURNING *`, values);
    await client.query(
      `INSERT INTO agreement_template_approval_history
       (agreement_id,version,from_status,to_status,reviewer_id,reason)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [d.form.id, d.form.version, from, to, req.user.id, G.trim(req.body.reason, 5000)]
    );
    await G.ensureVersionSnapshot(d.form.id, req.user.id, client, to);
    await G.audit({ agreementId: d.form.id, action: 'template_approval_status', fromStatus: from,
      toStatus: to, reason: req.body.reason, details: { version: d.form.version }, req, client });
    await client.query('COMMIT');
    res.json({ template: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

router.post('/generator/admin/templates/:id/fields', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await G.getFormDefinition(req.params.id, client);
    if (!d) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agreement template not found.' }); }
    const body = req.body || {};
    const kind = ['text','email','phone','textarea','number','date','select','radio','checkbox','file'].includes(body.kind) ? body.kind : null;
    const key = String(body.key || body.fieldKey || '').toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_|_$/g,'').slice(0,60);
    const label = G.trim(body.label, 200);
    if (!kind || !key || !label) throw Object.assign(new Error('kind, key and label are required.'), { statusCode: 400 });
    const sensitiveType = body.sensitiveType === 'identity_document' ? 'identity_document' : null;
    const popia = G.validatePopia({ ...body, sensitiveType });
    await bumpTemplateVersion(d.form.id, req, client, `Field added: ${label}`);
    const r = await client.query(
      `INSERT INTO agreement_fields
       (agreement_id,position,kind,field_key,label,placeholder,help,required,options,max_length,
        section_key,party_scope,condition_json,config,sensitive_type,popia_enabled,popia_purpose,
        popia_retention,popia_access,popia_ack_required)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [d.form.id, Number(body.position)||0, kind, key, label, G.trim(body.placeholder,200), G.trim(body.help,2000),
       !!body.required, JSON.stringify(asArray(body.options)), body.maxLength ? Math.min(10000,Math.max(1,Number(body.maxLength)||0)) : null,
       G.MASTER_SECTIONS.includes(body.sectionKey) ? body.sectionKey : 'agreement_specific_questions',
       G.trim(body.partyScope,40), JSON.stringify(asObject(body.condition)), JSON.stringify(asObject(body.config)),
       sensitiveType, !!body.popiaEnabled, popia && popia.purpose, popia && popia.retention, popia && popia.access, !!body.popiaAckRequired]
    );
    await client.query('COMMIT');
    res.status(201).json({ field: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'That field key is already used.' });
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

router.patch('/generator/admin/templates/:id/fields/:fieldId', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await G.getFormDefinition(req.params.id, client);
    if (!d) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agreement template not found.' }); }
    const found = d.fields.find((x) => Number(x.id) === Number(req.params.fieldId));
    if (!found) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Field not found.' }); }
    const b = req.body || {};
    const sensitiveType = b.sensitiveType === undefined ? found.sensitive_type : (b.sensitiveType === 'identity_document' ? 'identity_document' : null);
    const merged = {
      sensitiveType,
      popiaEnabled: b.popiaEnabled === undefined ? found.popia_enabled : !!b.popiaEnabled,
      popiaPurpose: b.popiaPurpose === undefined ? found.popia_purpose : b.popiaPurpose,
      popiaRetention: b.popiaRetention === undefined ? found.popia_retention : b.popiaRetention,
      popiaAccess: b.popiaAccess === undefined ? found.popia_access : b.popiaAccess,
    };
    const popia = G.validatePopia(merged);
    await bumpTemplateVersion(d.form.id, req, client, `Field edited: ${found.label}`);
    const r = await client.query(
      `UPDATE agreement_fields SET
         position=$3,label=$4,placeholder=$5,help=$6,required=$7,options=$8,max_length=$9,
         section_key=$10,party_scope=$11,condition_json=$12,config=$13,sensitive_type=$14,
         popia_enabled=$15,popia_purpose=$16,popia_retention=$17,popia_access=$18,popia_ack_required=$19
       WHERE id=$1 AND agreement_id=$2 RETURNING *`,
      [found.id,d.form.id,
       b.position === undefined ? found.position : Number(b.position)||0,
       b.label === undefined ? found.label : G.trim(b.label,200),
       b.placeholder === undefined ? found.placeholder : G.trim(b.placeholder,200),
       b.help === undefined ? found.help : G.trim(b.help,2000),
       b.required === undefined ? found.required : !!b.required,
       JSON.stringify(b.options === undefined ? asArray(found.options) : asArray(b.options)),
       b.maxLength === undefined ? found.max_length : (b.maxLength ? Math.min(10000,Math.max(1,Number(b.maxLength)||0)) : null),
       b.sectionKey === undefined ? found.section_key : (G.MASTER_SECTIONS.includes(b.sectionKey) ? b.sectionKey : 'agreement_specific_questions'),
       b.partyScope === undefined ? found.party_scope : G.trim(b.partyScope,40),
       JSON.stringify(b.condition === undefined ? asObject(found.condition_json) : asObject(b.condition)),
       JSON.stringify(b.config === undefined ? asObject(found.config) : asObject(b.config)),
       sensitiveType, merged.popiaEnabled, popia && popia.purpose, popia && popia.retention, popia && popia.access,
       b.popiaAckRequired === undefined ? found.popia_ack_required : !!b.popiaAckRequired]
    );
    await client.query('COMMIT');
    res.json({ field: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

router.delete('/generator/admin/templates/:id/fields/:fieldId', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await G.getFormDefinition(req.params.id, client);
    if (!d) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agreement template not found.' }); }
    const found = d.fields.find((x) => Number(x.id) === Number(req.params.fieldId));
    if (!found) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Field not found.' }); }
    await bumpTemplateVersion(d.form.id, req, client, `Field removed: ${found.label}`);
    await client.query('DELETE FROM agreement_fields WHERE id=$1 AND agreement_id=$2', [found.id,d.form.id]);
    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (err) { await client.query('ROLLBACK').catch(()=>{}); next(err); }
  finally { client.release(); }
});

router.get('/generator/admin/clauses', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query('SELECT * FROM agreement_clause_blocks ORDER BY active DESC,name');
    res.json({ clauses: r.rows });
  } catch (err) { next(err); }
});

router.post('/generator/admin/clauses', requireRole('admin'), async (req, res, next) => {
  try {
    const name = G.trim(req.body.name,180), body = cleanRichText(req.body.bodyHtml);
    if (!name || !body) return res.status(400).json({ error: 'Clause name and text are required.' });
    const r = await pool.query(
      `INSERT INTO agreement_clause_blocks(name,category,body_html,created_by,updated_by)
       VALUES($1,$2,$3,$4,$4) RETURNING *`, [name,G.trim(req.body.category,120),body,req.user.id]
    );
    res.status(201).json({ clause: r.rows[0] });
  } catch (err) { if (err.code==='23505') return res.status(409).json({error:'A clause already uses that name.'}); next(err); }
});

router.patch('/generator/admin/clauses/:id', requireRole('admin'), async (req,res,next)=>{
  try {
    const r=await pool.query(`UPDATE agreement_clause_blocks SET
      name=COALESCE($2,name),category=$3,body_html=COALESCE($4,body_html),active=COALESCE($5,active),updated_by=$6,updated_at=now()
      WHERE id=$1 RETURNING *`,[req.params.id,G.trim(req.body.name,180),req.body.category===undefined?null:G.trim(req.body.category,120),
      req.body.bodyHtml===undefined?null:cleanRichText(req.body.bodyHtml),req.body.active===undefined?null:!!req.body.active,req.user.id]);
    if(!r.rowCount)return res.status(404).json({error:'Clause not found.'});res.json({clause:r.rows[0]});
  }catch(err){next(err);}
});

router.post('/generator/admin/templates/:id/clauses', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();
  try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}
    await bumpTemplateVersion(d.form.id,req,client,'Agreement clause added');
    const r=await client.query(`INSERT INTO agreement_form_clauses(agreement_id,clause_block_id,position,title,body_html,condition_json,excluded)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[d.form.id,req.body.clauseBlockId||null,Number(req.body.position)||0,G.trim(req.body.title,220),
      req.body.bodyHtml?cleanRichText(req.body.bodyHtml):null,JSON.stringify(asObject(req.body.condition)),!!req.body.excluded]);
    await client.query('COMMIT');res.status(201).json({clause:r.rows[0]});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});next(err);}finally{client.release();}
});

router.delete('/generator/admin/templates/:id/clauses/:clauseId', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}
    await bumpTemplateVersion(d.form.id,req,client,'Agreement clause removed');const r=await client.query('DELETE FROM agreement_form_clauses WHERE id=$1 AND agreement_id=$2 RETURNING id',[req.params.clauseId,d.form.id]);if(!r.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Clause not found.'});}await client.query('COMMIT');res.json({deleted:true});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});next(err);}finally{client.release();}
});

router.post('/generator/admin/templates/:id/items', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}
    const kind=['note','upload'].includes(req.body.kind)?req.body.kind:null;const visibility=['internal_admin','party_b_visible','party_b_required'].includes(req.body.visibility)?req.body.visibility:null;const label=G.trim(req.body.label,220);if(!kind||!visibility||!label)throw Object.assign(new Error('kind, visibility and label are required.'),{statusCode:400});
    await bumpTemplateVersion(d.form.id,req,client,`${kind} requirement added`);const r=await client.query(`INSERT INTO agreement_form_items(agreement_id,position,kind,label,help,visibility,required,condition_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[d.form.id,Number(req.body.position)||0,kind,label,G.trim(req.body.help,3000),visibility,!!req.body.required||visibility==='party_b_required',JSON.stringify(asObject(req.body.condition))]);await client.query('COMMIT');res.status(201).json({item:r.rows[0]});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.delete('/generator/admin/templates/:id/items/:itemId', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();try{await client.query('BEGIN');const d=await G.getFormDefinition(req.params.id,client);if(!d){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}
    await bumpTemplateVersion(d.form.id,req,client,'Note/upload requirement removed');const r=await client.query('DELETE FROM agreement_form_items WHERE id=$1 AND agreement_id=$2 RETURNING id',[req.params.itemId,d.form.id]);if(!r.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Item not found.'});}await client.query('COMMIT');res.json({deleted:true});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});next(err);}finally{client.release();}
});

// ---------------------------------------------------------------------------
// INDIVIDUAL AGREEMENTS — create, assign, send, review, archive and audit.
// ---------------------------------------------------------------------------
router.get('/generator/admin/agreements', requireRole('admin'), async(req,res,next)=>{
  try{
    const params=[];const clauses=[];if(req.query.status){params.push(String(req.query.status));clauses.push(`s.workflow_status=$${params.length}`);}if(req.query.q){params.push(`%${String(req.query.q).trim()}%`);clauses.push(`(s.reference ILIKE $${params.length} OR COALESCE(s.signer_name,'') ILIKE $${params.length} OR a.title ILIKE $${params.length})`);}
    const r=await pool.query(`SELECT s.id,s.reference,s.reference_original,s.workflow_status,s.agreement_version,s.party_b_type,s.signer_name,s.signer_email,s.started_at,s.submitted_at,s.signed_at,s.locked_at,s.superseded_by_id,a.title,a.slug,
      EXISTS(SELECT 1 FROM agreement_submission_assignments x WHERE x.submission_id=s.id AND x.user_id=$${params.length+1}) assigned_to_me
      FROM agreement_submissions s JOIN agreement_forms a ON a.id=s.agreement_id ${clauses.length?'WHERE '+clauses.join(' AND '):''}
      ORDER BY s.started_at DESC LIMIT 1000`,[...params,req.user.id]);res.json({agreements:r.rows});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();try{await client.query('BEGIN');const formId=Number(req.body.templateId||req.body.agreementId);if(!Number.isInteger(formId))throw Object.assign(new Error('Choose an approved agreement template.'),{statusCode:400});
    const formRes=await client.query('SELECT * FROM agreement_forms WHERE id=$1',[formId]);if(!formRes.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement template not found.'});}const form=formRes.rows[0];
    const version=await approvedVersionForCreate(formId,client);if(!version)throw Object.assign(new Error('This template has no Approved or Published version yet.'),{statusCode:400});const snapshot=version.snapshot;
    const snapForm=snapshot.form||form;const partyBType=req.body.partyBType||null;if(partyBType&&!G.PARTY_B_TYPES.includes(partyBType))throw Object.assign(new Error('Party B must be Individual or Business.'),{statusCode:400});if(['individual','business'].includes(snapForm.signer_type)&&partyBType&&partyBType!==snapForm.signer_type)throw Object.assign(new Error(`This template requires Party B to be ${snapForm.signer_type}.`),{statusCode:400});
    const reference=await G.nextReference(client);const token=G.randomToken(32);const accessMethod=G.ACCESS_METHODS.includes(req.body.accessMethod)?req.body.accessMethod:(snapForm.access_method||'private_link');const signingOrder=G.SIGNING_ORDERS.includes(req.body.signingOrder)?req.body.signingOrder:(snapForm.signing_order||'party_b_first');
    let userId=req.body.memberUserId?Number(req.body.memberUserId):null;if(userId&&!Number.isInteger(userId))userId=null;if(accessMethod==='member_login'&&!userId)throw Object.assign(new Error('Member-login agreements must be assigned to a member.'),{statusCode:400});
    const paymentStatus=Number(snapForm.amount)>0&&snapForm.payment_mode!=='none'?'awaiting_payment':'not_required';
    const r=await client.query(`INSERT INTO agreement_submissions
      (agreement_id,user_id,reference,reference_original,signing_token,status,workflow_status,payment_status,
       agreement_version,template_version_id,party_b_type,access_method,signing_order,delivery_config,notification_config,
       title_at_signing,description_at_signing,rules_at_signing,terms_at_signing,post_signing_requirements_at_signing,
       require_witness_at_signing,require_company_stamp_at_signing,amount_at_signing,payment_mode_at_signing,
       service_scope_at_signing,service_name_at_signing,service_description_at_signing,service_reference_at_signing,
       client_name_at_signing,definition_at_signing,created_by_user_id)
      VALUES($1,$2,$3,$3,$4,'started','draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
      RETURNING *`,[formId,userId,reference,token,paymentStatus,version.version,version.id,partyBType,accessMethod,signingOrder,
      JSON.stringify(req.body.deliveryConfig?asObject(req.body.deliveryConfig):asObject(snapForm.delivery_config)),JSON.stringify(req.body.notificationConfig?asObject(req.body.notificationConfig):asObject(snapForm.notification_config)),
      snapForm.title,snapForm.description,snapForm.rules,snapForm.terms,snapForm.post_signing_requirements,!!snapForm.require_witness,!!snapForm.require_company_stamp,snapForm.amount,snapForm.payment_mode,
      snapForm.service_scope,snapForm.service_name,snapForm.service_description,snapForm.service_reference,snapForm.client_name,JSON.stringify(snapshot),req.user.id]);const s=r.rows[0];
    if(Array.isArray(req.body.partyBSigners)){for(const p of req.body.partyBSigners.slice(0,20)){await client.query(`INSERT INTO agreement_submission_parties(submission_id,party_side,party_type,role,legal_name,display_name,email,mobile,capacity,sign_order,required,metadata)
      VALUES($1,'party_b',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[s.id,G.PARTY_B_TYPES.includes(p.partyType)?p.partyType:(partyBType||'individual'),['primary','guardian','witness','authorised_representative','other'].includes(p.role)?p.role:'other',G.trim(p.legalName,240),G.trim(p.displayName,240),G.trim(p.email,255),G.trim(p.mobile,80),G.trim(p.capacity,180),Number(p.signOrder)||0,p.required!==false,JSON.stringify(asObject(p.metadata))]);}}
    const shortCode=await ensureFormShortCode(formId,client);await G.audit({agreementId:formId,submissionId:s.id,action:'agreement_created',toStatus:'draft',details:{templateVersion:version.version,accessMethod,signingOrder},req,client});await client.query('COMMIT');
    const site=String(process.env.SITE_URL||'https://www.unplugnews.com').replace(/\/$/,'');res.status(201).json({agreement:s,shortCode,secureLink:`${site}/unplug-agreement-generator.html?token=${encodeURIComponent(token)}`,resolver:`/a/${shortCode}`});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.get('/generator/admin/agreements/:id', requireRole('admin'), requireInstanceAccess, async(req,res,next)=>{
  try{const s=req.agreementSubmission;const [parties,items,audit,assignments]=await Promise.all([
    pool.query('SELECT * FROM agreement_submission_parties WHERE submission_id=$1 ORDER BY party_side,sign_order,id',[s.id]),
    pool.query(`SELECT si.*,fi.label,fi.kind,fi.visibility FROM agreement_submission_items si LEFT JOIN agreement_form_items fi ON fi.id=si.form_item_id WHERE si.submission_id=$1 ORDER BY si.id`,[s.id]),
    pool.query('SELECT * FROM agreement_audit_log WHERE submission_id=$1 ORDER BY created_at DESC,id DESC',[s.id]),
    pool.query(`SELECT x.*,u.full_name,u.email FROM agreement_submission_assignments x JOIN users u ON u.id=x.user_id WHERE x.submission_id=$1 ORDER BY x.created_at`,[s.id])]);res.json({agreement:s,parties:parties.rows,items:items.rows,audit:audit.rows,assignments:assignments.rows});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/assign', requireSuperAdmin, async(req,res,next)=>{
  try{const s=await loadSubmission(req.params.id);if(!s)return res.status(404).json({error:'Agreement record not found.'});const userId=Number(req.body.userId);if(!Number.isInteger(userId))return res.status(400).json({error:'Valid staff userId required.'});const u=await pool.query("SELECT id,role FROM users WHERE id=$1 AND role IN ('staff','admin')",[userId]);if(!u.rowCount)return res.status(400).json({error:'Assignment must be to an admin or staff account.'});await pool.query(`INSERT INTO agreement_submission_assignments(submission_id,user_id,assigned_by,assignment_role) VALUES($1,$2,$3,$4) ON CONFLICT(submission_id,user_id) DO UPDATE SET assigned_by=EXCLUDED.assigned_by,assignment_role=EXCLUDED.assignment_role,created_at=now()`,[s.id,userId,req.user.id,G.trim(req.body.assignmentRole,80)]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_assigned',details:{userId},req});res.json({assigned:true});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/send', requireRole('admin'), requireInstanceAccess, async(req,res,next)=>{
  try{const s=req.agreementSubmission;if(!['draft','sent','in_progress'].includes(s.workflow_status))return res.status(409).json({error:'This agreement can no longer be sent for editing.'});if(s.signing_order==='party_a_first'&&!s.party_a_signed_at)return res.status(409).json({error:'Party A must sign before this agreement can be sent.'});const email=G.trim(req.body.email||s.signer_email,255);if(!G.validEmail(email))return res.status(400).json({error:'A valid Party B email is required.'});const site=String(process.env.SITE_URL||'https://www.unplugnews.com').replace(/\/$/,'');const link=`${site}/unplug-agreement-generator.html?token=${encodeURIComponent(s.signing_token)}`;await sendEmail({to:email,subject:`Agreement for review — ${s.reference}`,text:`Please review and complete your Unplug agreement.\n\n${link}\n\nReference: ${s.reference}`});const from=s.workflow_status;await pool.query(`UPDATE agreement_submissions SET workflow_status='sent',signer_email=COALESCE(signer_email,$2) WHERE id=$1`,[s.id,email]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_sent',fromStatus:from,toStatus:'sent',details:{email},req});res.json({sent:true,link});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/remind', requireRole('admin'), requireInstanceAccess, async(req,res,next)=>{
  try{const s=req.agreementSubmission;if(['submitted','under_review','signed','completed','archived'].includes(s.workflow_status))return res.status(409).json({error:'This agreement no longer needs a completion reminder.'});const email=G.trim(req.body.email||s.signer_email,255);if(!G.validEmail(email))return res.status(400).json({error:'A valid Party B email is required.'});const site=String(process.env.SITE_URL||'https://www.unplugnews.com').replace(/\/$/,'');const link=`${site}/unplug-agreement-generator.html?token=${encodeURIComponent(s.signing_token)}`;await sendEmail({to:email,subject:`Reminder: agreement ${s.reference}`,text:`This is a reminder to complete your Unplug agreement.\n\n${link}\n\nReference: ${s.reference}`});await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_reminder_sent',details:{email},req});res.json({sent:true});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/reference-override', requireSuperAdmin, async(req,res,next)=>{
  try{const s=await loadSubmission(req.params.id);if(!s)return res.status(404).json({error:'Agreement record not found.'});const reference=G.trim(req.body.reference,80),reason=G.trim(req.body.reason,5000);if(!reference||!reason)return res.status(400).json({error:'New reference and audit reason are required.'});const r=await pool.query(`UPDATE agreement_submissions SET reference=$2,reference_original=COALESCE(reference_original,reference),reference_override_reason=$3 WHERE id=$1 RETURNING *`,[s.id,reference,reason]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'reference_overridden',reason,details:{original:s.reference,newReference:reference},req});res.json({agreement:r.rows[0]});
  }catch(err){if(err.code==='23505')return res.status(409).json({error:'That agreement reference is already in use.'});next(err);}
});

router.post('/generator/admin/agreements/:id/status', requireRole('admin'), requireInstanceAccess, async(req,res,next)=>{
  try{const s=req.agreementSubmission;const to=String(req.body.status||'');if(!G.WORKFLOW_STATUSES.includes(to))return res.status(400).json({error:'Invalid agreement status.'});if(!(STATUS_TRANSITIONS[s.workflow_status]||[]).includes(to))return res.status(409).json({error:`Status cannot move from ${s.workflow_status} to ${to}. Use Reopen or Restore when appropriate.`});if(to==='signed'){
      const signatures=await pool.query('SELECT DISTINCT party_side FROM agreement_signatures WHERE submission_id=$1',[s.id]);const sides=new Set(signatures.rows.map(x=>x.party_side));if(!sides.has('party_a')||!sides.has('party_b'))return res.status(409).json({error:'Both Party A and Party B must sign before status can become Signed.'});}
    await pool.query('UPDATE agreement_submissions SET workflow_status=$2 WHERE id=$1',[s.id,to]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'workflow_status_changed',fromStatus:s.workflow_status,toStatus:to,reason:req.body.reason,req});res.json({status:to});
  }catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/archive', requireRole('admin'), requireInstanceAccess, async(req,res,next)=>{
  try{const s=req.agreementSubmission;if(s.workflow_status==='archived')return res.json({archived:true});await pool.query("UPDATE agreement_submissions SET workflow_status='archived' WHERE id=$1",[s.id]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_archived',fromStatus:s.workflow_status,toStatus:'archived',reason:req.body.reason,details:{archivedFrom:s.workflow_status},req});res.json({archived:true});}catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/restore', requireRole('admin'), requireInstanceAccess, async(req,res,next)=>{
  try{const s=req.agreementSubmission;if(s.workflow_status!=='archived')return res.status(409).json({error:'Only archived agreements can be restored.'});const signs=await pool.query('SELECT DISTINCT party_side FROM agreement_signatures WHERE submission_id=$1',[s.id]);const sides=new Set(signs.rows.map(x=>x.party_side));const to=sides.has('party_a')&&sides.has('party_b')?'completed':(s.party_b_signed_at?'submitted':'draft');await pool.query('UPDATE agreement_submissions SET workflow_status=$2 WHERE id=$1',[s.id,to]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_restored',fromStatus:'archived',toStatus:to,reason:req.body.reason,req});res.json({restored:true,status:to});}catch(err){next(err);}
});

router.post('/generator/admin/agreements/:id/reopen', requireRole('admin'), requireInstanceAccess, async(req,res,next)=>{
  const client=await pool.connect();try{const reason=G.trim(req.body.reason,5000);if(!reason)return res.status(400).json({error:'A reopen reason is required for the audit history.'});await client.query('BEGIN');const s=await loadSubmission(req.params.id,client);if(!s){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement record not found.'});const fullySigned=!!(s.party_a_signed_at&&s.party_b_signed_at)||['signed','completed'].includes(s.workflow_status);
    if(fullySigned){const ref=await G.nextReference(client);const token=G.randomToken(32);const r=await client.query(`INSERT INTO agreement_submissions
      (agreement_id,user_id,reference,reference_original,signing_token,status,workflow_status,payment_status,agreement_version,template_version_id,party_b_type,access_method,signing_order,delivery_config,notification_config,draft_data,
       title_at_signing,description_at_signing,rules_at_signing,terms_at_signing,post_signing_requirements_at_signing,require_witness_at_signing,require_company_stamp_at_signing,amount_at_signing,payment_mode_at_signing,service_scope_at_signing,service_name_at_signing,service_description_at_signing,service_reference_at_signing,client_name_at_signing,definition_at_signing,created_by_user_id)
      SELECT agreement_id,user_id,$2,$2,$3,'started','in_progress',payment_status,agreement_version,template_version_id,party_b_type,access_method,signing_order,delivery_config,notification_config,answers,
       title_at_signing,description_at_signing,rules_at_signing,terms_at_signing,post_signing_requirements_at_signing,require_witness_at_signing,require_company_stamp_at_signing,amount_at_signing,payment_mode_at_signing,service_scope_at_signing,service_name_at_signing,service_description_at_signing,service_reference_at_signing,client_name_at_signing,definition_at_signing,$4 FROM agreement_submissions WHERE id=$1 RETURNING *`,[s.id,ref,token,req.user.id]);const replacement=r.rows[0];await client.query('UPDATE agreement_submissions SET superseded_by_id=$2 WHERE id=$1',[s.id,replacement.id]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'signed_agreement_superseded',fromStatus:s.workflow_status,toStatus:s.workflow_status,reason,details:{supersededBy:replacement.id,newReference:ref},req,client});await G.audit({agreementId:s.agreement_id,submissionId:replacement.id,action:'agreement_reopened_as_new_record',toStatus:'in_progress',reason,details:{supersedes:s.id},req,client});await client.query('COMMIT');return res.status(201).json({reopened:true,superseded:true,agreement:replacement});}
    await client.query(`UPDATE agreement_submissions SET workflow_status='in_progress',locked_at=NULL,reopened_at=now() WHERE id=$1`,[s.id]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'agreement_reopened',fromStatus:s.workflow_status,toStatus:'in_progress',reason,req,client});await client.query('COMMIT');res.json({reopened:true,superseded:false,status:'in_progress'});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});next(err);}finally{client.release();}
});

router.post('/generator/admin/agreements/:id/party-a-sign', requireRole('admin'), requireInstanceAccess, async(req,res,next)=>{
  const client=await pool.connect();try{await client.query('BEGIN');const s=await loadSubmission(req.params.id,client);if(!s){await client.query('ROLLBACK');return res.status(404).json({error:'Agreement record not found.'});if(s.party_a_signed_at)throw Object.assign(new Error('Party A has already signed this agreement.'),{statusCode:409});if(s.signing_order==='party_b_first'&&!s.party_b_signed_at)throw Object.assign(new Error('Party B must sign first for this agreement.'),{statusCode:409});const type=G.SIGNATURE_TYPES.includes(req.body.signatureType)?req.body.signatureType:'typed';const name=G.trim(req.body.name,220);if(!name)throw Object.assign(new Error('Party A signer name is required.'),{statusCode:400});let signatureText=type==='typed'?G.trim(req.body.signatureText||name,500):null;let signatureUrl=null;if(type!=='typed')signatureUrl=await G.storePrivateSignature(req.body.signatureDataUrl,'party-a');const p=await client.query(`INSERT INTO agreement_submission_parties(submission_id,party_side,party_type,role,legal_name,email,capacity,sign_order,required)
      VALUES($1,'party_a','business','authorised_representative',$2,$3,$4,0,true) RETURNING *`,[s.id,name,G.trim(req.body.email,255),G.trim(req.body.capacity,180)]);await client.query(`INSERT INTO agreement_signatures(submission_id,party_id,party_side,signature_type,signature_text,signature_url,declaration_accepted,ip,user_agent,metadata)
      VALUES($1,$2,'party_a',$3,$4,$5,true,$6,$7,$8)`,[s.id,p.rows[0].id,type,signatureText,signatureUrl,req.ip,G.trim(req.get('user-agent'),1000),JSON.stringify({capacity:req.body.capacity||null})]);await client.query('UPDATE agreement_submissions SET party_a_signed_at=now() WHERE id=$1',[s.id]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'party_a_signed',details:{name,type},req,client});await client.query('COMMIT');res.json({signed:true});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.get('/generator/admin/agreements/:id/pdf', requireRole('admin'), requireInstanceAccess, async(req,res,next)=>{
  try{const pdf=await renderPdfForSubmission(req.agreementSubmission);if(!pdf)return res.status(404).json({error:'Agreement definition unavailable.'});res.type('application/pdf').attachment(`${req.agreementSubmission.reference}.pdf`).send(pdf);}catch(err){next(err);}
});

// ---------------------------------------------------------------------------
// PARTY B SECURE LINK / MEMBER JOURNEY
// ---------------------------------------------------------------------------
router.get('/generator/access/:token', async(req,res,next)=>{
  try{const s=await G.submissionByToken(req.params.token);if(!s)return res.status(404).json({error:'This private agreement link is not valid.'});try{if(s.access_method==='member_login'){G.assertAccessMethod({...s,locked_at:null},req);}}catch(err){return res.status(err.statusCode||403).json({error:err.message});}const snapshot=await snapshotForSubmission(s);if(!snapshot)return res.status(404).json({error:'Agreement definition unavailable.'});const draft=asObject(s.draft_data);const def=G.publicDefinitionFromSnapshot(snapshot,s.party_b_type||draft.partyBType,asObject(draft.answers));const delivery=asObject(s.delivery_config);res.set('Cache-Control','no-store');res.json({agreement:{id:s.id,reference:s.reference,status:s.workflow_status,locked:!!s.locked_at,verified:!!s.verified_at,partyASigned:!!s.party_a_signed_at,partyBSigned:!!s.party_b_signed_at,...def},draft,delivery:{allowDownload:delivery.allow_download!==false,emailPartyB:!!delivery.email_party_b,manualDownloadEmail:!!delivery.manual_download_email}});
  }catch(err){next(err);}
});

router.patch('/generator/access/:token/draft', publicSubmitLimiter, async(req,res,next)=>{
  const client=await pool.connect();try{await client.query('BEGIN');const s=await G.submissionByToken(req.params.token,client);if(!s){await client.query('ROLLBACK');return res.status(404).json({error:'This private agreement link is not valid.'});G.assertAccessMethod(s,req);const snapshot=await snapshotForSubmission(s,client);if(!snapshot)throw Object.assign(new Error('Agreement definition unavailable.'),{statusCode:404});let partyBType=req.body.partyBType||s.party_b_type||null;const fixed=snapshot.form&&snapshot.form.signer_type;if(['individual','business'].includes(fixed))partyBType=fixed;if(!G.PARTY_B_TYPES.includes(partyBType))throw Object.assign(new Error('Choose whether Party B is an Individual or Business.'),{statusCode:400});const prior=asObject(s.draft_data);const draft={...prior,...asObject(req.body),partyBType,answers:{...asObject(prior.answers),...asObject(req.body.answers)}};const from=s.workflow_status;const to=['draft','sent'].includes(from)?'in_progress':from;await client.query(`UPDATE agreement_submissions SET draft_data=$2,party_b_type=$3,last_saved_at=now(),workflow_status=$4,user_id=COALESCE(user_id,$5),signer_name=COALESCE($6,signer_name),signer_email=COALESCE($7,signer_email) WHERE id=$1`,[s.id,JSON.stringify(draft),partyBType,to,req.user&&req.user.id,G.trim(req.body.signerName,200),G.trim(req.body.signerEmail,255)]);
    if(Array.isArray(req.body.items)){for(const item of req.body.items.slice(0,100)){const formItem=(snapshot.items||[]).find(x=>Number(x.id)===Number(item.id));if(!formItem||formItem.visibility==='internal_admin')continue;const note=formItem.kind==='note'?G.trim(item.noteText,10000):null;const url=formItem.kind==='upload'?G.trim(item.uploadUrl,1000):null;if(url&&!uploads.isPublicStorageUrl(url))throw Object.assign(new Error(`Upload for “${formItem.label}” was not stored through Unplug.`),{statusCode:400});await client.query(`INSERT INTO agreement_submission_items(submission_id,form_item_id,note_text,upload_url,submitted_by_user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(submission_id,form_item_id) DO UPDATE SET note_text=EXCLUDED.note_text,upload_url=EXCLUDED.upload_url,submitted_by_user_id=EXCLUDED.submitted_by_user_id,updated_at=now()`,[s.id,formItem.id,note,url,req.user&&req.user.id]);}}
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'party_b_draft_saved',fromStatus:from,toStatus:to,req,client});await client.query('COMMIT');res.json({saved:true,status:to,lastSavedAt:new Date().toISOString()});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.post('/generator/access/:token/verify/request', publicSubmitLimiter, async(req,res,next)=>{
  try{const s=await G.submissionByToken(req.params.token);if(!s)return res.status(404).json({error:'This private agreement link is not valid.'});G.assertAccessMethod(s,req);const channel=req.body.channel==='mobile'?'mobile':'email';const draft=asObject(s.draft_data);const destination=G.trim(req.body.destination||(channel==='email'?(draft.signerEmail||s.signer_email):draft.mobile),255);if(channel==='email'&&!G.validEmail(destination))return res.status(400).json({error:'A valid email address is required.'});if(channel==='mobile'&&!destination)return res.status(400).json({error:'A mobile number is required.'});const code=String(Math.floor(100000+Math.random()*900000));await pool.query('UPDATE agreement_verification_codes SET consumed_at=COALESCE(consumed_at,now()) WHERE submission_id=$1 AND channel=$2 AND consumed_at IS NULL',[s.id,channel]);await pool.query(`INSERT INTO agreement_verification_codes(submission_id,channel,destination,code_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')`,[s.id,channel,destination,G.codeHash(s.id,code)]);
    if(channel==='email')await sendEmail({to:destination,subject:`Unplug agreement verification — ${s.reference}`,text:`Your one-time verification code is ${code}. It expires in 10 minutes. If you did not request this code, ignore this email.`});else{const webhook=process.env.AGREEMENT_SMS_WEBHOOK_URL;if(!webhook)return res.status(503).json({error:'Mobile-code delivery is not configured. Please verify by email instead.'});const response=await fetch(webhook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:destination,message:`Unplug verification code: ${code}. Expires in 10 minutes.`})});if(!response.ok)throw Object.assign(new Error('Mobile-code delivery failed. Please use email verification.'),{statusCode:502});}
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'verification_code_requested',details:{channel,destination:channel==='email'?destination.replace(/^(.).+(@.*)$/,'$1***$2'):'***'+destination.slice(-4)},req});res.json({sent:true,channel,...(process.env.NODE_ENV==='test'?{testCode:code}:{})});
  }catch(err){if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}
});

router.post('/generator/access/:token/verify/confirm', publicSubmitLimiter, async(req,res,next)=>{
  try{const s=await G.submissionByToken(req.params.token);if(!s)return res.status(404).json({error:'This private agreement link is not valid.'});G.assertAccessMethod(s,req);const channel=req.body.channel==='mobile'?'mobile':'email';const r=await pool.query(`SELECT * FROM agreement_verification_codes WHERE submission_id=$1 AND channel=$2 AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,[s.id,channel]);if(!r.rowCount)return res.status(400).json({error:'No active verification code was found. Request a new code.'});const row=r.rows[0];if(row.attempts>=5)return res.status(429).json({error:'Too many incorrect attempts. Request a new code.'});if(G.codeHash(s.id,String(req.body.code||''))!==row.code_hash){await pool.query('UPDATE agreement_verification_codes SET attempts=attempts+1 WHERE id=$1',[row.id]);return res.status(400).json({error:'That verification code is not correct.'});}await pool.query('UPDATE agreement_verification_codes SET consumed_at=now() WHERE id=$1',[row.id]);await pool.query('UPDATE agreement_submissions SET verified_at=now(),verification_channel=$2 WHERE id=$1',[s.id,channel]);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'party_b_verified',details:{channel},req});res.json({verified:true});
  }catch(err){next(err);}
});

router.post('/generator/access/:token/submit', publicSubmitLimiter, async(req,res,next)=>{
  const client=await pool.connect();try{await client.query('BEGIN');const s=await G.submissionByToken(req.params.token,client);if(!s){await client.query('ROLLBACK');return res.status(404).json({error:'This private agreement link is not valid.'});G.assertAccessMethod(s,req);if(!s.verified_at)throw Object.assign(new Error('Verify your email or mobile number before submitting.'),{statusCode:400});if(s.signing_order==='party_a_first'&&!s.party_a_signed_at)throw Object.assign(new Error('Party A must sign before Party B can submit this agreement.'),{statusCode:409});if(Number(s.amount_at_signing)>0&&s.payment_mode_at_signing==='before_sign'&&s.payment_status!=='confirmed')throw Object.assign(new Error('Payment must be confirmed before this agreement can be submitted.'),{statusCode:402});const snapshot=await snapshotForSubmission(s,client);if(!snapshot)throw Object.assign(new Error('Agreement definition unavailable.'),{statusCode:404});const draft={...asObject(s.draft_data),...asObject(req.body)};const partyBType=req.body.partyBType||s.party_b_type||draft.partyBType;const fixed=snapshot.form&&snapshot.form.signer_type;if(['individual','business'].includes(fixed)&&partyBType!==fixed)throw Object.assign(new Error(`This agreement requires Party B to be ${fixed}.`),{statusCode:400});if(!G.PARTY_B_TYPES.includes(partyBType))throw Object.assign(new Error('Choose whether Party B is an Individual or Business.'),{statusCode:400});const declarations=asObject(req.body.declarationsAccepted||draft.declarationsAccepted);const answers=G.validateAnswers(snapshot,partyBType,{...asObject(draft.answers),...asObject(req.body.answers)},declarations);await validateRequiredItems(snapshot,answers,s.id,client);const signerName=G.trim(req.body.signerName||draft.signerName||s.signer_name,200),signerEmail=G.trim(req.body.signerEmail||draft.signerEmail||s.signer_email,255);if(!signerName)throw Object.assign(new Error('Signer name is required.'),{statusCode:400});if(signerEmail&&!G.validEmail(signerEmail))throw Object.assign(new Error('Signer email is not valid.'),{statusCode:400});const signatureType=G.SIGNATURE_TYPES.includes(req.body.signatureType)?req.body.signatureType:null;if(!signatureType)throw Object.assign(new Error('Choose typed, drawn or uploaded signature.'),{statusCode:400});let signatureText=null,signatureUrl=null;if(signatureType==='typed'){signatureText=G.trim(req.body.signatureText||signerName,500);if(!signatureText)throw Object.assign(new Error('Type your signature.'),{statusCode:400});}else signatureUrl=await G.storePrivateSignature(req.body.signatureDataUrl,'party-b');
    let party=await client.query(`SELECT * FROM agreement_submission_parties WHERE submission_id=$1 AND party_side='party_b' AND role='primary' ORDER BY id LIMIT 1`,[s.id]);if(!party.rowCount)party=await client.query(`INSERT INTO agreement_submission_parties(submission_id,party_side,party_type,role,legal_name,email,mobile,capacity,sign_order,required) VALUES($1,'party_b',$2,'primary',$3,$4,$5,$6,0,true) RETURNING *`,[s.id,partyBType,signerName,signerEmail,G.trim(draft.mobile,80),G.trim(req.body.capacity||draft.capacity,180)]);
    await client.query(`INSERT INTO agreement_signatures(submission_id,party_id,party_side,signature_type,signature_text,signature_url,declaration_accepted,ip,user_agent,metadata) VALUES($1,$2,'party_b',$3,$4,$5,true,$6,$7,$8)`,[s.id,party.rows[0].id,signatureType,signatureText,signatureUrl,req.ip,G.trim(req.get('user-agent'),1000),JSON.stringify({declarations})]);
    const definition=snapshot;await client.query(`UPDATE agreement_submissions SET answers=$2,draft_data=$3,declarations_accepted=$4,party_b_type=$5,signer_name=$6,signer_email=$7,signer_type_at_signing=$5,signature_type=$8,signature_text=$9,signature_url=$10,business_signatory_capacity=$11,party_b_signed_at=now(),submitted_at=now(),signed_at=now(),workflow_status='submitted',status='complete',locked_at=now(),definition_at_signing=$12 WHERE id=$1`,[s.id,JSON.stringify(answers),JSON.stringify(draft),JSON.stringify(declarations),partyBType,signerName,signerEmail,signatureType,signatureText,signatureUrl,G.trim(req.body.capacity||draft.capacity,180),JSON.stringify(definition)]);
    await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'party_b_submitted_and_signed',fromStatus:s.workflow_status,toStatus:'submitted',details:{signatureType,partyBType},req,client});await client.query('COMMIT');const updated=await loadSubmission(s.id);const pdf=await renderPdfForSubmission(updated);await notifySubmission(updated,snapshot,pdf,signerEmail).catch(async err=>{console.error('[agreement generator notification]',err);await G.audit({agreementId:s.agreement_id,submissionId:s.id,action:'notification_failed',details:{message:err.message},req}).catch(()=>{});});const delivery=asObject(updated.delivery_config);res.json({submitted:true,reference:updated.reference,status:'submitted',downloadAllowed:delivery.allow_download!==false,downloadUrl:delivery.allow_download!==false?`/agreement-forms/generator/access/${encodeURIComponent(req.params.token)}/pdf`:null});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.get('/generator/access/:token/pdf', async(req,res,next)=>{
  try{const s=await G.submissionByToken(req.params.token);if(!s)return res.status(404).json({error:'This private agreement link is not valid.'});if(!s.locked_at&&!['submitted','under_review','signed','completed','archived'].includes(s.workflow_status))return res.status(409).json({error:'Submit the agreement before downloading the completed PDF.'});const delivery=asObject(s.delivery_config);if(delivery.allow_download===false)return res.status(403).json({error:'Download is disabled for this agreement.'});const pdf=await renderPdfForSubmission(s);if(!pdf)return res.status(404).json({error:'Agreement definition unavailable.'});res.type('application/pdf').attachment(`${s.reference}.pdf`).send(pdf);}catch(err){next(err);}
});

router.get('/generator/member/agreements', requireAuth, async(req,res,next)=>{
  try{const r=await pool.query(`SELECT s.id,s.reference,s.workflow_status,s.agreement_version,s.started_at,s.submitted_at,s.signed_at,a.title,a.slug FROM agreement_submissions s JOIN agreement_forms a ON a.id=s.agreement_id WHERE s.user_id=$1 AND s.access_method IN ('member_login','both') ORDER BY s.started_at DESC`,[req.user.id]);res.json({agreements:r.rows});}catch(err){next(err);}
});

module.exports = router;
