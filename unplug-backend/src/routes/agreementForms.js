// Agreement Forms — configurable agreements, signatures, records and sharing.
//
// Reconstructed from the preserved Agreement Forms handover and the locked
// 2026-09-10 decisions. This is deliberately separate from routes/agreements.js,
// which owns the older four-type signed_agreements system and is not modified.

const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const { generateUnique } = require('../utils/reference');
const { sendEmail } = require('../utils/email');
const { logActivity } = require('./activityLog');
const requestContext = require('../middleware/requestContext');
const uploads = require('./uploads');
const { generateAgreementDocument } = require('../utils/agreementDocument');

const router = express.Router();
const shortLinkRouter = express.Router();

const KINDS = ['text', 'email', 'phone', 'textarea', 'number', 'date',
  'select', 'radio', 'checkbox', 'file'];
const PAYMENT_MODES = ['none', 'before_sign', 'after_sign'];
const SIGNER_TYPES = ['individual', 'business'];
const STATUSES = ['draft', 'active', 'archived'];

const trim = (value, max = 5000) => {
  if (value === null || value === undefined) return null;
  const out = String(value).trim().slice(0, max);
  return out || null;
};

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 100);
}

function asJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function effectiveState(form) {
  const now = Date.now();
  if (form.status !== 'active') return { active: false, reason: form.status };
  if (form.opens_at && new Date(form.opens_at).getTime() > now) {
    return { active: false, reason: 'not-yet' };
  }
  if (form.closes_at && new Date(form.closes_at).getTime() <= now) {
    return { active: false, reason: 'archived' };
  }
  return { active: true, reason: 'active' };
}

async function fieldsFor(id, client = pool) {
  const r = await client.query(
    'SELECT * FROM agreement_fields WHERE agreement_id = $1 ORDER BY position, id', [id]);
  return r.rows;
}

async function getAgreementBySlug(slug, client = pool) {
  const r = await client.query(
    'SELECT * FROM agreement_forms WHERE LOWER(slug) = LOWER($1)', [slug]);
  return r.rows[0] || null;
}

async function getAgreementById(id, client = pool) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const r = await client.query('SELECT * FROM agreement_forms WHERE id = $1', [n]);
  return r.rows[0] || null;
}

async function ensureShortCode(agreementId, client = pool) {
  const current = await client.query('SELECT short_code FROM agreement_forms WHERE id = $1', [agreementId]);
  if (!current.rowCount) return null;
  if (current.rows[0].short_code) return current.rows[0].short_code;
  const code = await generateUnique({
    table: 'agreement_forms', column: 'short_code', length: 10, client,
  });
  await client.query('UPDATE agreement_forms SET short_code = $2 WHERE id = $1', [agreementId, code]);
  return code;
}

function publicDefinition(form, fields) {
  const state = effectiveState(form);
  return {
    slug: form.slug,
    title: form.title,
    description: form.description,
    category: form.category,
    version: form.version,
    open: state.active,
    reason: state.reason,
    howItWorks: asJsonArray(form.how_it_works),
    rules: form.rules,
    terms: form.terms,
    postSigningRequirements: form.post_signing_requirements,
    signerType: form.signer_type,
    minAge: form.min_age,
    requireWitness: form.require_witness,
    requireCompanyStamp: form.require_company_stamp,
    amount: form.amount === null ? null : Number(form.amount),
    paymentMode: form.payment_mode,
    service: {
      scope: form.service_scope,
      name: form.service_name,
      description: form.service_description,
      reference: form.service_reference,
      clientName: form.client_name,
    },
    fields: fields.map((field) => ({
      id: field.id,
      key: field.field_key,
      kind: field.kind,
      label: field.label,
      placeholder: field.placeholder,
      help: field.help,
      required: field.required,
      options: asJsonArray(field.options),
      maxLength: field.max_length,
    })),
  };
}

function validEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || ''));
}

function ageOn(dateValue, at = new Date()) {
  const dob = new Date(dateValue);
  if (Number.isNaN(dob.getTime()) || dob > at) return null;
  let years = at.getUTCFullYear() - dob.getUTCFullYear();
  const month = at.getUTCMonth() - dob.getUTCMonth();
  if (month < 0 || (month === 0 && at.getUTCDate() < dob.getUTCDate())) years -= 1;
  return years;
}

async function validateAnswers(form, fields, given, user) {
  const answers = {};
  for (const field of fields) {
    const raw = given[field.field_key];
    if (field.kind === 'checkbox') {
      const on = raw === true || raw === 'true' || raw === 'on';
      if (field.required && !on) throw Object.assign(new Error(`Please tick “${field.label}”.`), { statusCode: 400 });
      answers[field.field_key] = on;
      continue;
    }

    if (field.kind === 'file') {
      const url = trim(raw, 1000);
      if (field.required && !url) throw Object.assign(new Error(`“${field.label}” needs a file.`), { statusCode: 400 });
      if (url && !user) throw Object.assign(new Error('Sign in as a member to attach a file.'), { statusCode: 401 });
      if (url && !uploads.isPublicStorageUrl(url)) {
        throw Object.assign(new Error('That file was not uploaded through Unplug. Please choose it again.'), { statusCode: 400 });
      }
      answers[field.field_key] = url;
      continue;
    }

    const value = trim(raw, Math.min(Number(field.max_length) || 5000, 10000));
    if (field.required && !value) {
      throw Object.assign(new Error(`“${field.label}” is required.`), { statusCode: 400 });
    }
    if (value && field.kind === 'email' && !validEmail(value)) {
      throw Object.assign(new Error(`“${field.label}” does not look like an email address.`), { statusCode: 400 });
    }
    if (value && (field.kind === 'select' || field.kind === 'radio')) {
      const options = asJsonArray(field.options);
      if (options.length && !options.includes(value)) {
        throw Object.assign(new Error(`“${value}” is not one of the choices for “${field.label}”.`), { statusCode: 400 });
      }
    }
    answers[field.field_key] = value;
  }
  return answers;
}

function fieldAnswerByKey(answers, keys) {
  for (const key of keys) {
    if (answers[key]) return answers[key];
  }
  return null;
}

async function storePrivateImage(dataUrl, label) {
  if (!dataUrl) return null;
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!match) throw Object.assign(new Error(`${label} must be a PNG, JPEG or WebP image.`), { statusCode: 400 });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) {
    throw Object.assign(new Error(`${label} must be smaller than 2 MB.`), { statusCode: 400 });
  }
  if (!uploads.r2PrivateConfigured) {
    throw Object.assign(new Error('Private signature storage is temporarily unavailable. Please use a typed signature or try again later.'), { statusCode: 503 });
  }
  const ext = match[1] === 'jpg' ? 'jpeg' : match[1];
  return uploads.uploadPrivateBuffer(buffer, `agreement-${label.toLowerCase().replace(/[^a-z]+/g, '-')}-${crypto.randomBytes(6).toString('hex')}.${ext}`, `image/${ext}`);
}

async function buildSignedPdf(submissionId, client = pool, preview = false) {
  const s = await client.query('SELECT * FROM agreement_submissions WHERE id = $1', [submissionId]);
  if (!s.rowCount) return null;
  const submission = s.rows[0];
  const definition = submission.definition_at_signing || {};
  const fields = Array.isArray(definition.fields) ? definition.fields : [];
  return generateAgreementDocument({ submission, fields, preview, client });
}

async function signatureCount(agreementId, client = pool) {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM agreement_submissions
      WHERE agreement_id = $1 AND signed_at IS NOT NULL`, [agreementId]);
  return r.rows[0].n;
}

async function anySubmissionCount(agreementId, client = pool) {
  const r = await client.query(
    'SELECT count(*)::int AS n FROM agreement_submissions WHERE agreement_id = $1', [agreementId]);
  return r.rows[0].n;
}

// Controlled placement list, matching the Growth Application pattern
// (growth_application_placements): an admin can only pick a page that a real
// button actually renders on, never a free-text key nothing consumes. Start
// small (checkout only) rather than a page nothing wires up yet.
const PUBLIC_PAGE_KEYS = new Set(['checkout']);
function sanitizePages(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))]
    .filter((x) => PUBLIC_PAGE_KEYS.has(x))
    .slice(0, 50);
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

async function sendAgreementLink({ agreement, to, recipientName, senderUserId, consultantId = null }) {
  if (!validEmail(to)) throw Object.assign(new Error('A valid recipient email is required.'), { statusCode: 400 });
  const site = String(process.env.SITE_URL || 'https://www.unplugnews.com').replace(/\/$/, '');
  const link = `${site}/?p=agreement&slug=${encodeURIComponent(agreement.slug)}`;
  await sendEmail({
    to,
    subject: `${agreement.title} — Unplug Magazine`,
    text: `${recipientName ? `Hi ${recipientName},\n\n` : ''}Please review and sign “${agreement.title}”.\n\n${link}\n\nUnplug Magazine`,
  });
  await pool.query(
    `INSERT INTO agreement_sends
       (agreement_id, recipient_email, recipient_name, sent_by_user_id, sales_consultant_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [agreement.id, String(to).toLowerCase(), trim(recipientName, 200), senderUserId || null, consultantId]
  );
  return link;
}

// ---------------------------------------------------------------------------
// Public placement feed. There is deliberately NO automatic public Agreements
// directory. A caller must name the approved page, and only agreements that
// admin explicitly placed on that page are returned.
// GET /agreement-forms?page=home
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const page = String(req.query.page || '').trim().toLowerCase();
    if (!page) return res.json({ agreements: [], publicDirectory: false });
    const r = await pool.query(
      `SELECT id, slug, title, description, category, version, short_code,
              service_name, amount, payment_mode, closes_at, button_label
         FROM agreement_forms
        WHERE status = 'active' AND published = true
          AND (opens_at IS NULL OR opens_at <= now())
          AND (closes_at IS NULL OR closes_at > now())
          AND public_pages ? $1
        ORDER BY title ASC`, [page]);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ agreements: r.rows, publicDirectory: false, page });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Member dashboard feed. This is intentionally independent of public publication:
// an admin can show an active agreement to signed-in members without placing it
// on any public page.
// GET /agreement-forms/member
// ---------------------------------------------------------------------------
router.get('/member', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, slug, title, description, category, version, short_code,
              service_name, amount, payment_mode, opens_at, closes_at, button_label
         FROM agreement_forms
        WHERE status = 'active' AND member_visible = true
          AND (opens_at IS NULL OR opens_at <= now())
          AND (closes_at IS NULL OR closes_at > now())
        ORDER BY title ASC`
    );
    res.set('Cache-Control', 'private, max-age=30');
    res.json({ agreements: r.rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Short link resolver. It resolves metadata; the frontend controls navigation.
// GET /a/:code
// ---------------------------------------------------------------------------
shortLinkRouter.get('/:code', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT slug, title, status, opens_at, closes_at
         FROM agreement_forms WHERE LOWER(short_code) = LOWER($1)`, [req.params.code]);
    if (!r.rowCount) return res.status(404).json({ error: 'That agreement link is not valid.' });
    const state = effectiveState(r.rows[0]);
    res.json({ slug: r.rows[0].slug, title: r.rows[0].title, open: state.active, reason: state.reason });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Admin list / records / templates
// ---------------------------------------------------------------------------
router.get('/admin/list', requireRole('admin'), async (req, res, next) => {
  try {
    const q = trim(req.query.q, 200);
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE (a.name ILIKE $1 OR a.title ILIKE $1 OR COALESCE(a.category,'') ILIKE $1
                       OR COALESCE(a.service_name,'') ILIKE $1)`;
    }
    const r = await pool.query(
      `SELECT a.*,
              (SELECT count(*)::int FROM agreement_fields f WHERE f.agreement_id=a.id) AS field_count,
              (SELECT count(*)::int FROM agreement_submissions s WHERE s.agreement_id=a.id AND s.signed_at IS NOT NULL) AS signature_count
         FROM agreement_forms a ${where}
        ORDER BY CASE WHEN a.status='active' THEN 0 WHEN a.status='draft' THEN 1 ELSE 2 END,
                 a.updated_at DESC`, params);
    res.json({ agreements: r.rows.map((a) => ({ ...a, effectiveStatus: effectiveState(a).reason })) });
  } catch (err) { next(err); }
});

router.get('/admin/templates/list', requireRole('admin'), async (req, res, next) => {
  try {
    const templates = await pool.query('SELECT * FROM agreement_templates ORDER BY is_builtin DESC, name ASC');
    for (const template of templates.rows) {
      const f = await pool.query('SELECT * FROM template_fields WHERE template_id=$1 ORDER BY position,id', [template.id]);
      template.fields = f.rows;
    }
    res.json({ templates: templates.rows });
  } catch (err) { next(err); }
});

router.get('/admin/records', requireRole('admin'), async (req, res, next) => {
  try {
    const clauses = ['s.signed_at IS NOT NULL'];
    const values = [];
    if (req.query.agreementId) { values.push(Number(req.query.agreementId)); clauses.push(`s.agreement_id=$${values.length}`); }
    if (req.query.email) { values.push(`%${String(req.query.email).trim()}%`); clauses.push(`COALESCE(s.signer_email,'') ILIKE $${values.length}`); }
    if (req.query.q) {
      values.push(`%${String(req.query.q).trim()}%`);
      clauses.push(`(s.reference ILIKE $${values.length} OR COALESCE(s.signer_name,'') ILIKE $${values.length} OR a.title ILIKE $${values.length})`);
    }
    const r = await pool.query(
      `SELECT s.id, s.agreement_id, s.reference, s.signer_name, s.signer_email,
              s.agreement_version, s.payment_status, s.signed_at, s.download_token,
              a.title AS current_title, a.slug
         FROM agreement_submissions s
         JOIN agreement_forms a ON a.id=s.agreement_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY s.signed_at DESC LIMIT 1000`, values);
    res.json({ records: r.rows });
  } catch (err) { next(err); }
});

router.get('/admin/records.csv', requireRole('admin'), async (req, res, next) => {
  try {
    const clauses = ['s.signed_at IS NOT NULL'];
    const values = [];
    if (req.query.agreementId) { values.push(Number(req.query.agreementId)); clauses.push(`s.agreement_id=$${values.length}`); }
    if (req.query.email) { values.push(`%${String(req.query.email).trim()}%`); clauses.push(`COALESCE(s.signer_email,'') ILIKE $${values.length}`); }
    if (req.query.q) {
      values.push(`%${String(req.query.q).trim()}%`);
      clauses.push(`(s.reference ILIKE $${values.length} OR COALESCE(s.signer_name,'') ILIKE $${values.length} OR a.title ILIKE $${values.length})`);
    }
    const r = await pool.query(
      `SELECT s.reference, a.title, s.agreement_version, s.signer_name, s.signer_email,
              s.payment_status, s.signed_at
         FROM agreement_submissions s JOIN agreement_forms a ON a.id=s.agreement_id
        WHERE ${clauses.join(' AND ')} ORDER BY s.signed_at DESC`, values);
    const rows = [['Reference','Agreement','Version','Signer','Email','Payment','Signed at'],
      ...r.rows.map((x) => [x.reference,x.title,`v${x.agreement_version}`,x.signer_name,x.signer_email,x.payment_status,x.signed_at])];
    res.type('text/csv').attachment('agreement-records.csv').send(rows.map((row) => row.map(csvCell).join(',')).join('\n'));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------
router.post('/admin', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const name = trim(req.body.name, 160);
    const title = trim(req.body.title, 220) || name;
    if (!name) return res.status(400).json({ error: 'The agreement needs a name.' });
    const slug = slugify(req.body.slug || name);
    if (!slug) return res.status(400).json({ error: 'That name does not make a usable address.' });
    const signerType = SIGNER_TYPES.includes(req.body.signerType) ? req.body.signerType : 'individual';
    const templateId = Number(req.body.templateId);

    await client.query('BEGIN');
    let template = null;
    if (Number.isInteger(templateId)) {
      const t = await client.query('SELECT * FROM agreement_templates WHERE id=$1', [templateId]);
      template = t.rows[0] || null;
    }
    const r = await client.query(
      `INSERT INTO agreement_forms
       (template_id,name,slug,title,description,category,signer_type,rules,terms,
        post_signing_requirements,amount,payment_mode,min_age,require_witness,
        require_company_stamp,how_it_works,reminder_days,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [template && template.id, name, slug, title,
       trim(req.body.description, 10000) || (template && template.description),
       trim(req.body.category, 120) || (template && template.category),
       req.body.signerType ? signerType : ((template && template.signer_type) || signerType),
       req.body.rules !== undefined ? trim(req.body.rules, 50000) : (template && template.rules),
       req.body.terms !== undefined ? trim(req.body.terms, 50000) : (template && template.terms),
       req.body.postSigningRequirements !== undefined ? trim(req.body.postSigningRequirements, 20000) : (template && template.post_signing_requirements),
       req.body.amount !== undefined ? Math.max(0, Number(req.body.amount) || 0) : (template && template.amount),
       PAYMENT_MODES.includes(req.body.paymentMode) ? req.body.paymentMode : ((template && template.payment_mode) || 'none'),
       req.body.minAge !== undefined ? (Number(req.body.minAge) || null) : (template && template.min_age),
       req.body.requireWitness !== undefined ? !!req.body.requireWitness : !!(template && template.require_witness),
       req.body.requireCompanyStamp !== undefined ? !!req.body.requireCompanyStamp : !!(template && template.require_company_stamp),
       JSON.stringify(Array.isArray(req.body.howItWorks) ? req.body.howItWorks : (template ? asJsonArray(template.how_it_works) : [])),
       req.body.reminderDays !== undefined ? (Number(req.body.reminderDays) || null) : (template && template.reminder_days),
       req.user.id]);
    const agreement = r.rows[0];

    if (template) {
      await client.query(
        `INSERT INTO agreement_fields
           (agreement_id,position,kind,field_key,label,placeholder,help,required,options,max_length)
         SELECT $1,position,kind,field_key,label,placeholder,help,required,options,max_length
           FROM template_fields WHERE template_id=$2 ORDER BY position,id`,
        [agreement.id, template.id]);
    }
    await client.query('COMMIT');
    await logActivity(req.user.id, 'agreement_form_created', `Created agreement “${name}”`).catch(() => {});
    res.status(201).json({ agreement, fields: await fieldsFor(agreement.id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'An agreement already uses that name or address.' });
    next(err);
  } finally { client.release(); }
});

router.get('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const agreement = await getAgreementById(req.params.id);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found.' });
    const [fields, links] = await Promise.all([
      fieldsFor(agreement.id),
      pool.query('SELECT * FROM agreement_links WHERE agreement_id=$1 ORDER BY id', [agreement.id]),
    ]);
    res.json({ agreement: { ...agreement, effectiveStatus: effectiveState(agreement).reason }, fields, links: links.rows });
  } catch (err) { next(err); }
});

router.patch('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const agreement = await getAgreementById(req.params.id);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found.' });
    const sets = [];
    const values = [];
    const set = (col, val) => { values.push(val); sets.push(`${col}=$${values.length}`); };
    let materialEdit = false;

    const material = (bodyKey, column, transform) => {
      if (req.body[bodyKey] !== undefined) {
        set(column, transform ? transform(req.body[bodyKey]) : req.body[bodyKey]);
        materialEdit = true;
      }
    };
    material('name','name',(v)=>trim(v,160));
    material('title','title',(v)=>trim(v,220));
    material('description','description',(v)=>trim(v,10000));
    material('category','category',(v)=>trim(v,120));
    material('rules','rules',(v)=>trim(v,50000));
    material('terms','terms',(v)=>trim(v,50000));
    material('postSigningRequirements','post_signing_requirements',(v)=>trim(v,20000));
    material('howItWorks','how_it_works',(v)=>JSON.stringify(Array.isArray(v)?v:[]));
    material('signerType','signer_type',(v)=>SIGNER_TYPES.includes(v)?v:agreement.signer_type);
    material('minAge','min_age',(v)=>v === '' || v === null ? null : Math.max(0, Number(v)||0));
    material('requireWitness','require_witness',(v)=>!!v);
    material('requireCompanyStamp','require_company_stamp',(v)=>!!v);
    material('amount','amount',(v)=>v === '' || v === null ? null : Math.max(0,Number(v)||0));
    material('paymentMode','payment_mode',(v)=>PAYMENT_MODES.includes(v)?v:agreement.payment_mode);
    material('serviceScope','service_scope',(v)=>v === 'external'?'external':'website');
    material('serviceName','service_name',(v)=>trim(v,200));
    material('serviceDescription','service_description',(v)=>trim(v,10000));
    material('serviceReference','service_reference',(v)=>trim(v,160));
    material('clientName','client_name',(v)=>trim(v,200));

    if (req.body.slug !== undefined) {
      const slug = slugify(req.body.slug);
      if (!slug) return res.status(400).json({ error: 'That address is not usable.' });
      set('slug', slug); materialEdit = true;
    }
    if (req.body.publicPages !== undefined) set('public_pages', JSON.stringify(sanitizePages(req.body.publicPages)));
    if (req.body.published !== undefined) set('published', !!req.body.published);
    if (req.body.memberVisible !== undefined) set('member_visible', !!req.body.memberVisible);
    if (req.body.buttonLabel !== undefined) set('button_label', trim(req.body.buttonLabel, 80));
    if (req.body.opensAt !== undefined) set('opens_at', req.body.opensAt || null);
    if (req.body.closesAt !== undefined) set('closes_at', req.body.closesAt || null);
    if (req.body.reminderDays !== undefined) set('reminder_days', req.body.reminderDays === '' || req.body.reminderDays === null ? null : Math.max(0,Number(req.body.reminderDays)||0));

    if (req.body.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Status must be draft, active or archived.' });
      if (req.body.status === 'active') {
        const count = await pool.query('SELECT count(*)::int AS n FROM agreement_fields WHERE agreement_id=$1', [agreement.id]);
        if (count.rows[0].n === 0) return res.status(400).json({ error: 'Add at least one field before activating this agreement.' });
        if (!agreement.rules && req.body.rules === undefined && !agreement.terms && req.body.terms === undefined) {
          return res.status(400).json({ error: 'Add rules or terms before activating this agreement.' });
        }
        if (agreement.closes_at && new Date(agreement.closes_at) <= new Date() && req.body.closesAt === undefined) set('closes_at', null);
      }
      set('status', req.body.status);
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    if (materialEdit) sets.push('version=version+1');
    sets.push('updated_at=now()');
    values.push(agreement.id);
    const r = await pool.query(`UPDATE agreement_forms SET ${sets.join(',')} WHERE id=$${values.length} RETURNING *`, values);
    if (r.rows[0].status === 'active') r.rows[0].short_code = await ensureShortCode(agreement.id);
    await logActivity(req.user.id, 'agreement_form_updated', `Updated agreement “${r.rows[0].name}”`).catch(() => {});
    res.json({ agreement: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another agreement already uses that address.' });
    next(err);
  }
});

router.delete('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const agreement = await getAgreementById(req.params.id);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found.' });
    const n = await anySubmissionCount(agreement.id);
    if (n > 0) {
      await pool.query('UPDATE agreement_forms SET status=\'archived\', published=false, updated_at=now() WHERE id=$1', [agreement.id]);
      await logActivity(req.user.id, 'agreement_form_archived', `Archived agreement “${agreement.name}” instead of deleting it because it has records`).catch(() => {});
      return res.json({ deleted: false, archived: true, message: 'This agreement has signing/payment history, so it was archived instead of deleted.' });
    }
    await pool.query('DELETE FROM agreement_forms WHERE id=$1', [agreement.id]);
    await logActivity(req.user.id, 'agreement_form_deleted', `Deleted agreement “${agreement.name}”`).catch(() => {});
    res.json({ deleted: true, archived: false });
  } catch (err) { next(err); }
});

router.post('/bulk', requireRole('admin'), async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isInteger))].slice(0,100) : [];
    const action = req.body.action;
    if (!ids.length || !['archive','delete'].includes(action)) return res.status(400).json({ error: 'Choose agreement ids and archive or delete.' });
    const results = [];
    for (const id of ids) {
      const agreement = await getAgreementById(id);
      if (!agreement) { results.push({ id, result: 'not_found' }); continue; }
      if (action === 'archive') {
        await pool.query('UPDATE agreement_forms SET status=\'archived\', published=false, updated_at=now() WHERE id=$1', [id]);
        results.push({ id, result: 'archived' });
      } else if ((await anySubmissionCount(id)) > 0) {
        await pool.query('UPDATE agreement_forms SET status=\'archived\', published=false, updated_at=now() WHERE id=$1', [id]);
        results.push({ id, result: 'archived_has_history' });
      } else {
        await pool.query('DELETE FROM agreement_forms WHERE id=$1', [id]);
        results.push({ id, result: 'deleted' });
      }
    }
    res.json({ results });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------
router.post('/admin/:id/fields', requireRole('admin'), async (req, res, next) => {
  try {
    const agreement = await getAgreementById(req.params.id);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found.' });
    const kind = KINDS.includes(req.body.kind) ? req.body.kind : null;
    const key = String(req.body.key || req.body.fieldKey || '').toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_|_$/g,'').slice(0,60);
    const label = trim(req.body.label,200);
    if (!kind || !key || !label) return res.status(400).json({ error: 'kind, key and label are required.' });
    const r = await pool.query(
      `INSERT INTO agreement_fields
       (agreement_id,position,kind,field_key,label,placeholder,help,required,options,max_length)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [agreement.id, Number(req.body.position)||0, kind, key, label, trim(req.body.placeholder,200),
       trim(req.body.help,2000), !!req.body.required, JSON.stringify(asJsonArray(req.body.options)),
       req.body.maxLength ? Math.min(10000,Math.max(1,Number(req.body.maxLength)||0)) : null]);
    await pool.query('UPDATE agreement_forms SET version=version+1,updated_at=now() WHERE id=$1', [agreement.id]);
    res.status(201).json({ field: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That field key is already used on this agreement.' });
    next(err);
  }
});

router.patch('/admin/:id/fields/:fieldId', requireRole('admin'), async (req, res, next) => {
  try {
    const fieldId = Number(req.params.fieldId);
    const agreementId = Number(req.params.id);
    if (!Number.isInteger(fieldId) || !Number.isInteger(agreementId)) return res.status(400).json({ error: 'Valid ids are required.' });
    const sets=[]; const values=[]; const set=(c,v)=>{values.push(v);sets.push(`${c}=$${values.length}`);};
    if (req.body.position!==undefined) set('position',Number(req.body.position)||0);
    if (req.body.kind!==undefined) { if(!KINDS.includes(req.body.kind)) return res.status(400).json({error:'Invalid field kind.'}); set('kind',req.body.kind); }
    if (req.body.label!==undefined) set('label',trim(req.body.label,200));
    if (req.body.placeholder!==undefined) set('placeholder',trim(req.body.placeholder,200));
    if (req.body.help!==undefined) set('help',trim(req.body.help,2000));
    if (req.body.required!==undefined) set('required',!!req.body.required);
    if (req.body.options!==undefined) set('options',JSON.stringify(asJsonArray(req.body.options)));
    if (req.body.maxLength!==undefined) set('max_length',req.body.maxLength?Math.min(10000,Math.max(1,Number(req.body.maxLength)||0)):null);
    if (!sets.length) return res.status(400).json({error:'Nothing to change.'});
    values.push(fieldId,agreementId);
    const r=await pool.query(`UPDATE agreement_fields SET ${sets.join(',')} WHERE id=$${values.length-1} AND agreement_id=$${values.length} RETURNING *`,values);
    if(!r.rowCount) return res.status(404).json({error:'Field not found.'});
    await pool.query('UPDATE agreement_forms SET version=version+1,updated_at=now() WHERE id=$1',[agreementId]);
    res.json({field:r.rows[0]});
  } catch(err){next(err);}
});

router.delete('/admin/:id/fields/:fieldId', requireRole('admin'), async (req,res,next)=>{
  try{
    const r=await pool.query('DELETE FROM agreement_fields WHERE id=$1 AND agreement_id=$2 RETURNING id',[req.params.fieldId,req.params.id]);
    if(!r.rowCount) return res.status(404).json({error:'Field not found.'});
    await pool.query('UPDATE agreement_forms SET version=version+1,updated_at=now() WHERE id=$1',[req.params.id]);
    res.json({deleted:true});
  }catch(err){next(err);}
});

// ---------------------------------------------------------------------------
// Draft history / duplicate / templates
// ---------------------------------------------------------------------------
async function definitionSnapshot(id, client = pool) {
  const agreement = await getAgreementById(id, client);
  if (!agreement) return null;
  return { agreement, fields: await fieldsFor(id, client) };
}

router.post('/admin/:id/drafts', requireRole('admin'), async(req,res,next)=>{
  try{
    const snap=await definitionSnapshot(req.params.id);
    if(!snap) return res.status(404).json({error:'Agreement not found.'});
    const r=await pool.query('INSERT INTO agreement_draft_versions (agreement_id,snapshot,created_by) VALUES ($1,$2,$3) RETURNING *',[req.params.id,JSON.stringify(snap),req.user.id]);
    res.status(201).json({draft:r.rows[0]});
  }catch(err){next(err);}
});

router.get('/admin/:id/drafts', requireRole('admin'), async(req,res,next)=>{
  try{
    const r=await pool.query('SELECT id,agreement_id,created_by,restored_from_id,created_at FROM agreement_draft_versions WHERE agreement_id=$1 ORDER BY created_at DESC,id DESC',[req.params.id]);
    res.json({drafts:r.rows});
  }catch(err){next(err);}
});

router.post('/admin/:id/drafts/:draftId/restore', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();
  try{
    const signed=await signatureCount(req.params.id,client);
    if(signed>0) return res.status(409).json({error:'A signed agreement cannot have an old draft applied over it. Duplicate it instead.'});
    const d=await client.query('SELECT snapshot FROM agreement_draft_versions WHERE id=$1 AND agreement_id=$2',[req.params.draftId,req.params.id]);
    if(!d.rowCount) return res.status(404).json({error:'Draft not found.'});
    const snap=d.rows[0].snapshot; const a=snap.agreement||{};
    await client.query('BEGIN');
    await client.query(`UPDATE agreement_forms SET name=$2,slug=$3,title=$4,description=$5,category=$6,signer_type=$7,rules=$8,terms=$9,
      post_signing_requirements=$10,min_age=$11,require_witness=$12,require_company_stamp=$13,amount=$14,payment_mode=$15,
      service_scope=$16,service_name=$17,service_description=$18,service_reference=$19,client_name=$20,how_it_works=$21,
      version=version+1,updated_at=now() WHERE id=$1`,[req.params.id,a.name,a.slug,a.title,a.description,a.category,a.signer_type,a.rules,a.terms,
      a.post_signing_requirements,a.min_age,a.require_witness,a.require_company_stamp,a.amount,a.payment_mode,a.service_scope,a.service_name,
      a.service_description,a.service_reference,a.client_name,JSON.stringify(asJsonArray(a.how_it_works))]);
    await client.query('DELETE FROM agreement_fields WHERE agreement_id=$1',[req.params.id]);
    for(const f of (snap.fields||[])){
      await client.query(`INSERT INTO agreement_fields (agreement_id,position,kind,field_key,label,placeholder,help,required,options,max_length)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[req.params.id,f.position,f.kind,f.field_key,f.label,f.placeholder,f.help,f.required,JSON.stringify(asJsonArray(f.options)),f.max_length]);
    }
    const after=await definitionSnapshot(req.params.id,client);
    await client.query('INSERT INTO agreement_draft_versions (agreement_id,snapshot,created_by,restored_from_id) VALUES ($1,$2,$3,$4)',[req.params.id,JSON.stringify(after),req.user.id,req.params.draftId]);
    await client.query('COMMIT');
    res.json({restored:true,definition:after});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});next(err);}finally{client.release();}
});

router.post('/admin/:id/duplicate', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();
  try{
    const source=await getAgreementById(req.params.id,client);
    if(!source) return res.status(404).json({error:'Agreement not found.'});
    await client.query('BEGIN');
    let slug=slugify(`${source.slug}-copy`);
    for(let i=2;;i+=1){const exists=await client.query('SELECT 1 FROM agreement_forms WHERE LOWER(slug)=LOWER($1)',[slug]);if(!exists.rowCount)break;slug=slugify(`${source.slug}-copy-${i}`);}
    const r=await client.query(`INSERT INTO agreement_forms
      (template_id,name,slug,title,description,category,signer_type,rules,terms,post_signing_requirements,version,status,published,
       opens_at,closes_at,min_age,require_witness,require_company_stamp,public_pages,service_scope,service_name,service_description,
       service_reference,client_name,amount,payment_mode,how_it_works,reminder_days,created_by)
      SELECT template_id,name||' — Copy',$2,title,description,category,signer_type,rules,terms,post_signing_requirements,1,'draft',false,
       NULL,NULL,min_age,require_witness,require_company_stamp,'[]'::jsonb,service_scope,service_name,service_description,
       service_reference,client_name,amount,payment_mode,how_it_works,reminder_days,$3 FROM agreement_forms WHERE id=$1 RETURNING *`,[source.id,slug,req.user.id]);
    const copy=r.rows[0];
    await client.query(`INSERT INTO agreement_fields (agreement_id,position,kind,field_key,label,placeholder,help,required,options,max_length)
      SELECT $1,position,kind,field_key,label,placeholder,help,required,options,max_length FROM agreement_fields WHERE agreement_id=$2`,[copy.id,source.id]);
    await client.query('COMMIT');
    res.status(201).json({agreement:copy,fields:await fieldsFor(copy.id)});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});next(err);}finally{client.release();}
});

router.post('/admin/:id/save-as-template', requireRole('admin'), async(req,res,next)=>{
  const client=await pool.connect();
  try{
    const a=await getAgreementById(req.params.id,client);if(!a)return res.status(404).json({error:'Agreement not found.'});
    const name=trim(req.body.name,160)||`${a.name} Template`;
    await client.query('BEGIN');
    const t=await client.query(`INSERT INTO agreement_templates
      (name,category,title,description,signer_type,rules,terms,post_signing_requirements,amount,payment_mode,min_age,require_witness,require_company_stamp,how_it_works,reminder_days,is_builtin,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16) RETURNING *`,[name,a.category,a.title,a.description,a.signer_type,a.rules,a.terms,a.post_signing_requirements,a.amount,a.payment_mode,a.min_age,a.require_witness,a.require_company_stamp,JSON.stringify(asJsonArray(a.how_it_works)),a.reminder_days,req.user.id]);
    await client.query(`INSERT INTO template_fields (template_id,position,kind,field_key,label,placeholder,help,required,options,max_length)
      SELECT $1,position,kind,field_key,label,placeholder,help,required,options,max_length FROM agreement_fields WHERE agreement_id=$2`,[t.rows[0].id,a.id]);
    await client.query('COMMIT');res.status(201).json({template:t.rows[0]});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.code==='23505')return res.status(409).json({error:'A template already uses that name.'});next(err);}finally{client.release();}
});

// ---------------------------------------------------------------------------
// Preview — uses the real public definition / PDF generator but stores nothing.
// ---------------------------------------------------------------------------
router.get('/admin/:id/preview/sign', requireRole('admin'), async(req,res,next)=>{
  try{const a=await getAgreementById(req.params.id);if(!a)return res.status(404).json({error:'Agreement not found.'});res.json({preview:true,agreement:publicDefinition({...a,status:'active'},await fieldsFor(a.id))});}catch(err){next(err);}
});
router.get('/admin/:id/preview/document', requireRole('admin'), async(req,res,next)=>{
  try{
    const a=await getAgreementById(req.params.id);if(!a)return res.status(404).json({error:'Agreement not found.'});const fields=await fieldsFor(a.id);
    const fake={reference:'PREVIEW',signer_name:'Preview Signer',signer_email:'preview@example.com',signature_type:'typed',signature_text:'PREVIEW SIGNATURE',submitted_at:new Date(),
      agreement_version:a.version,title_at_signing:a.title,description_at_signing:a.description,rules_at_signing:a.rules,terms_at_signing:a.terms,
      post_signing_requirements_at_signing:a.post_signing_requirements,require_witness_at_signing:a.require_witness,require_company_stamp_at_signing:a.require_company_stamp,
      amount_at_signing:a.amount,payment_mode_at_signing:a.payment_mode,service_scope_at_signing:a.service_scope,service_name_at_signing:a.service_name,
      service_description_at_signing:a.service_description,service_reference_at_signing:a.service_reference,client_name_at_signing:a.client_name,
      answers:Object.fromEntries(fields.map(f=>[f.field_key,`Preview ${f.label}`]))};
    const pdf=await generateAgreementDocument({submission:fake,fields,preview:true});res.type('application/pdf').send(pdf);
  }catch(err){next(err);}
});

// ---------------------------------------------------------------------------
// Sharing / reminders / consultant access
// ---------------------------------------------------------------------------
router.post('/admin/:id/send-email', requireRole('admin'), async(req,res,next)=>{
  try{const a=await getAgreementById(req.params.id);if(!a)return res.status(404).json({error:'Agreement not found.'});if(!effectiveState(a).active)return res.status(400).json({error:'Activate the agreement before sending it.'});const link=await sendAgreementLink({agreement:a,to:req.body.email,recipientName:req.body.name,senderUserId:req.user.id});res.json({sent:true,link});}catch(err){if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}
});
router.get('/admin/:id/sends', requireRole('admin'), async(req,res,next)=>{try{const r=await pool.query('SELECT * FROM agreement_sends WHERE agreement_id=$1 ORDER BY sent_at DESC',[req.params.id]);res.json({sends:r.rows});}catch(err){next(err);}});
router.post('/admin/:id/remind-now', requireRole('admin'), async(req,res,next)=>{
  try{
    const a=await getAgreementById(req.params.id);if(!a)return res.status(404).json({error:'Agreement not found.'});
    const targets=await pool.query(`SELECT DISTINCT LOWER(recipient_email) AS email, MAX(recipient_name) AS name
      FROM agreement_sends x WHERE agreement_id=$1 AND reminded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agreement_submissions s WHERE s.agreement_id=x.agreement_id AND s.signed_at IS NOT NULL AND LOWER(COALESCE(s.signer_email,''))=LOWER(x.recipient_email))
      GROUP BY LOWER(recipient_email)`,[a.id]);
    let sent=0;const site=String(process.env.SITE_URL||'https://www.unplugnews.com').replace(/\/$/,'');const link=`${site}/?p=agreement&slug=${encodeURIComponent(a.slug)}`;
    for(const target of targets.rows){await sendEmail({to:target.email,subject:`Reminder: ${a.title}`,text:`${target.name?`Hi ${target.name},\n\n`:''}This is a reminder to review and sign “${a.title}”.\n\n${link}\n\nUnplug Magazine`});await pool.query('UPDATE agreement_sends SET reminded_at=now() WHERE agreement_id=$1 AND LOWER(recipient_email)=LOWER($2) AND reminded_at IS NULL',[a.id,target.email]);sent+=1;}
    res.json({sent});
  }catch(err){next(err);}
});
router.get('/admin/:id/access', requireRole('admin'), async(req,res,next)=>{try{const r=await pool.query(`SELECT x.*,s.name,s.email FROM agreement_consultant_access x JOIN sales_consultants s ON s.id=x.sales_consultant_id WHERE x.agreement_id=$1 ORDER BY s.name`,[req.params.id]);res.json({access:r.rows});}catch(err){next(err);}});
router.post('/admin/:id/access', requireRole('admin'), async(req,res,next)=>{
  try{const a=await getAgreementById(req.params.id);if(!a)return res.status(404).json({error:'Agreement not found.'});if(!(effectiveState(a).active&&a.published))return res.status(400).json({error:'Consultant access can only be granted while the agreement is Active and Published.'});const cid=Number(req.body.consultantId);if(!Number.isInteger(cid))return res.status(400).json({error:'A valid consultant is required.'});const c=await pool.query('SELECT id FROM sales_consultants WHERE id=$1 AND active=true',[cid]);if(!c.rowCount)return res.status(404).json({error:'That consultant does not exist or is inactive.'});const r=await pool.query(`INSERT INTO agreement_consultant_access(agreement_id,sales_consultant_id,granted_by) VALUES($1,$2,$3) ON CONFLICT(agreement_id,sales_consultant_id) DO UPDATE SET granted_by=EXCLUDED.granted_by,granted_at=now() RETURNING *`,[a.id,cid,req.user.id]);res.status(201).json({access:r.rows[0]});}catch(err){next(err);}
});
router.delete('/admin/:id/access/:grantId', requireRole('admin'), async(req,res,next)=>{try{const r=await pool.query('DELETE FROM agreement_consultant_access WHERE id=$1 AND agreement_id=$2 RETURNING id',[req.params.grantId,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Access grant not found.'});res.json({deleted:true});}catch(err){next(err);}});

router.get('/consultant/mine', requireRole('consultant'), async(req,res,next)=>{
  try{const c=await pool.query('SELECT id FROM sales_consultants WHERE user_id=$1 AND active=true',[req.user.id]);if(!c.rowCount)return res.json({agreements:[]});const r=await pool.query(`SELECT a.id,a.slug,a.short_code,a.title,a.description,a.category,a.amount,a.payment_mode,a.service_name
    FROM agreement_consultant_access x JOIN agreement_forms a ON a.id=x.agreement_id
    WHERE x.sales_consultant_id=$1 AND a.status='active' AND a.published=true AND (a.opens_at IS NULL OR a.opens_at<=now()) AND (a.closes_at IS NULL OR a.closes_at>now()) ORDER BY a.title`,[c.rows[0].id]);res.json({agreements:r.rows});}catch(err){next(err);}
});
router.post('/consultant/:id/send-email', requireRole('consultant'), async(req,res,next)=>{
  try{const c=await pool.query('SELECT id FROM sales_consultants WHERE user_id=$1 AND active=true',[req.user.id]);if(!c.rowCount)return res.status(403).json({error:'No active consultant profile is linked to this account.'});const a=await getAgreementById(req.params.id);if(!a||!(effectiveState(a).active&&a.published))return res.status(404).json({error:'That agreement is not available.'});const grant=await pool.query('SELECT 1 FROM agreement_consultant_access WHERE agreement_id=$1 AND sales_consultant_id=$2',[a.id,c.rows[0].id]);if(!grant.rowCount)return res.status(403).json({error:'You do not have access to send this agreement.'});const link=await sendAgreementLink({agreement:a,to:req.body.email,recipientName:req.body.name,senderUserId:req.user.id,consultantId:c.rows[0].id});res.json({sent:true,link});}catch(err){if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}
});

// GET /agreement-forms/consultant/clients — which of a consultant's referred
// clients have signed which agreements. Same "referred" definition as the
// Growth Application clients view: a user with a CONFIRMED payment carrying
// this consultant's sales_consultant_id. A client can appear with zero, one,
// or several submissions — nothing here is scoped to agreements this
// consultant themself has access to send; it's simply what their clients
// have signed, anywhere on the site.
router.get('/consultant/clients', requireRole('consultant'), async (req, res, next) => {
  try {
    const consultant = await pool.query(
      'SELECT id FROM sales_consultants WHERE user_id = $1 AND active = true',
      [req.user.id]
    );
    if (!consultant.rowCount) return res.json({ clients: [] });

    const result = await pool.query(
      `SELECT u.id AS user_id,
              COALESCE(u.full_name, SPLIT_PART(u.email, '@', 1)) AS name,
              u.email,
              COALESCE(
                json_agg(
                  json_build_object(
                    'agreement_title', s.title_at_signing,
                    'status', s.status,
                    'signed_at', s.signed_at,
                    'reference', s.reference
                  ) ORDER BY s.started_at DESC
                ) FILTER (WHERE s.id IS NOT NULL), '[]'
              ) AS submissions
         FROM (
           SELECT DISTINCT p.user_id
             FROM payments p
            WHERE p.sales_consultant_id = $1 AND p.status = 'confirmed'
         ) referred
         JOIN users u ON u.id = referred.user_id
         LEFT JOIN agreement_submissions s ON s.user_id = referred.user_id
        GROUP BY u.id, u.full_name, u.email
        ORDER BY u.full_name NULLS LAST, u.email ASC`,
      [consultant.rows[0].id]
    );

    res.json({ clients: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// On-site links / gates metadata. Actual required-gate enforcement is wired into
// each target service route separately; this table is not a magic global switch.
// ---------------------------------------------------------------------------
router.post('/admin/:id/links', requireRole('admin'), async(req,res,next)=>{try{const a=await getAgreementById(req.params.id);if(!a)return res.status(404).json({error:'Agreement not found.'});const target=trim(req.body.targetType,80);if(!target)return res.status(400).json({error:'targetType is required.'});const r=await pool.query(`INSERT INTO agreement_links(agreement_id,target_type,target_reference,route_hint,required,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(agreement_id,target_type,COALESCE(target_reference,'')) DO UPDATE SET route_hint=EXCLUDED.route_hint,required=EXCLUDED.required RETURNING *`,[a.id,target,trim(req.body.targetReference,160),trim(req.body.routeHint,500),!!req.body.required,req.user.id]);res.status(201).json({link:r.rows[0]});}catch(err){next(err);}});
router.delete('/admin/:id/links/:linkId', requireRole('admin'), async(req,res,next)=>{try{const r=await pool.query('DELETE FROM agreement_links WHERE id=$1 AND agreement_id=$2 RETURNING id',[req.params.linkId,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Link not found.'});res.json({deleted:true});}catch(err){next(err);}});

// ---------------------------------------------------------------------------
// Pay-before-sign session. The normal Unplug /payments/initiate endpoint is
// intentionally still responsible for creating the actual payment. This route
// creates only the provisional linked resource. Paid guest checkout is a
// separate business decision because payments.user_id is currently mandatory.
// ---------------------------------------------------------------------------
router.post('/:slug/start-payment', requireAuth, async(req,res,next)=>{
  try{
    const a=await getAgreementBySlug(req.params.slug);if(!a)return res.status(404).json({error:'Agreement not found.'});const state=effectiveState(a);if(!state.active)return res.status(410).json({error:'This agreement is not currently open.'});if(a.payment_mode!=='before_sign'||Number(a.amount)<=0)return res.status(400).json({error:'This agreement does not require payment before signing.'});
    const existing=await pool.query(`SELECT s.* FROM agreement_submissions s LEFT JOIN payments p ON p.linked_type='agreement_payment' AND p.linked_id=s.id WHERE s.agreement_id=$1 AND s.user_id=$2 AND s.status IN('started','ready_to_sign') AND (p.status IS NULL OR p.status IN('pending','confirmed')) ORDER BY s.started_at DESC LIMIT 1`,[a.id,req.user.id]);
    if(existing.rowCount)return res.json({submissionId:existing.rows[0].id,signingToken:existing.rows[0].signing_token,linkedType:'agreement_payment',linkedId:existing.rows[0].id,amount:Number(a.amount),existing:true});
    const ref=await generateUnique({table:'agreement_submissions',column:'reference',prefix:'AGR-',length:10});const token=await generateUnique({table:'agreement_submissions',column:'signing_token',length:32});
    const r=await pool.query(`INSERT INTO agreement_submissions(agreement_id,user_id,reference,signing_token,status,payment_status,agreement_version,amount_at_signing,payment_mode_at_signing,service_scope_at_signing,service_name_at_signing,service_description_at_signing,service_reference_at_signing,client_name_at_signing) VALUES($1,$2,$3,$4,'started','awaiting_payment',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,[a.id,req.user.id,ref,token,a.version,a.amount,a.payment_mode,a.service_scope,a.service_name,a.service_description,a.service_reference,a.client_name]);
    res.status(201).json({submissionId:r.rows[0].id,signingToken:token,linkedType:'agreement_payment',linkedId:r.rows[0].id,amount:Number(a.amount),existing:false});
  }catch(err){next(err);}
});

// ---------------------------------------------------------------------------
// Public direct definition + signing + document retrieval
// ---------------------------------------------------------------------------
router.get('/:slug', async(req,res,next)=>{
  try{const a=await getAgreementBySlug(req.params.slug);if(!a)return res.status(404).json({error:'Agreement not found.'});res.json(publicDefinition(a,await fieldsFor(a.id)));}catch(err){next(err);}
});

router.post('/:slug/sign', publicSubmitLimiter, async(req,res,next)=>{
  const client=await pool.connect();
  try{
    const a=await getAgreementBySlug(req.params.slug,client);if(!a)return res.status(404).json({error:'Agreement not found.'});const state=effectiveState(a);if(!state.active)return res.status(410).json({error:'This agreement is not currently accepting signatures.'});
    const fields=await fieldsFor(a.id,client);const answers=await validateAnswers(a,fields,(req.body&&req.body.answers)||{},req.user);
    const signerName=trim(req.body.signerName,200)||fieldAnswerByKey(answers,['full_legal_name','signatory_name','registered_name']);
    const signerEmail=trim(req.body.signerEmail,255)||fieldAnswerByKey(answers,['email']);
    if(!signerName)return res.status(400).json({error:'Signer name is required.'});if(signerEmail&&!validEmail(signerEmail))return res.status(400).json({error:'Signer email is not valid.'});

    let guardianRequired=false;
    if(a.signer_type==='individual'&&a.min_age){const dob=fieldAnswerByKey(answers,['date_of_birth','dob','birth_date']);const age=ageOn(dob);if(age===null)return res.status(400).json({error:'A valid Date of Birth is required for this agreement.'});guardianRequired=age<a.min_age;}
    const guardianName=trim(req.body.guardianName,200);const guardianEmail=trim(req.body.guardianEmail,255);const guardianRelationship=trim(req.body.guardianRelationship,100);
    if(guardianRequired&&(!guardianName||!guardianRelationship))return res.status(400).json({error:'A parent or guardian name and relationship are required because the signer is under the agreement age.'});
    if(guardianEmail&&!validEmail(guardianEmail))return res.status(400).json({error:'Guardian email is not valid.'});
    if(a.require_witness&&(!trim(req.body.witnessName,200)||!trim(req.body.witnessSignature,500)))return res.status(400).json({error:'This agreement requires a witness name and witness signature.'});

    let provisional=null;
    if(a.payment_mode==='before_sign'&&Number(a.amount)>0){const token=trim(req.body.signingToken,96);if(!token)return res.status(402).json({error:'Payment is required before this agreement can be signed.'});const p=await client.query(`SELECT s.*,p.status AS live_payment_status,p.id AS live_payment_id FROM agreement_submissions s LEFT JOIN payments p ON p.linked_type='agreement_payment' AND p.linked_id=s.id WHERE s.agreement_id=$1 AND s.signing_token=$2 ORDER BY p.created_at DESC NULLS LAST LIMIT 1`,[a.id,token]);if(!p.rowCount||p.rows[0].live_payment_status!=='confirmed')return res.status(402).json({error:'The required payment has not been confirmed yet.'});if(req.user&&p.rows[0].user_id&&Number(p.rows[0].user_id)!==Number(req.user.id))return res.status(403).json({error:'That signing session belongs to another account.'});provisional=p.rows[0];}

    const signatureType=req.body.signatureType==='drawn'?'drawn':'typed';
    const typedSignature=trim(req.body.signatureText,500);
    const drawnSignatureUrl=signatureType==='drawn'?await storePrivateImage(req.body.signatureDataUrl,'Signature'):null;
    if(!guardianRequired&&!typedSignature&&!drawnSignatureUrl)return res.status(400).json({error:'Please type or draw your signature.'});
    let guardianSignatureUrl=null;let guardianSignatureText=trim(req.body.guardianSignatureText,500);
    if(guardianRequired){guardianSignatureUrl=req.body.guardianSignatureDataUrl?await storePrivateImage(req.body.guardianSignatureDataUrl,'Guardian signature'):null;if(!guardianSignatureText&&!guardianSignatureUrl)return res.status(400).json({error:'The parent or guardian must sign on the minor’s behalf.'});}
    const companyStampUrl=req.body.companyStampDataUrl?await storePrivateImage(req.body.companyStampDataUrl,'Company stamp'):null;
    if(a.require_company_stamp&&!companyStampUrl)return res.status(400).json({error:'This agreement requires a company stamp image.'});

    const ref=provisional?provisional.reference:await generateUnique({table:'agreement_submissions',column:'reference',prefix:'AGR-',length:10,client});
    const downloadToken=await generateUnique({table:'agreement_submissions',column:'download_token',length:32,client});
    const definition={fields:fields.map(f=>({field_key:f.field_key,label:f.label,kind:f.kind,required:f.required,options:f.options})),howItWorks:asJsonArray(a.how_it_works)};
    const values=[JSON.stringify(answers),signerName,signerEmail,a.signer_type,signatureType,guardianRequired?null:typedSignature,guardianRequired?null:drawnSignatureUrl,
      trim(req.body.businessSignatoryCapacity,160)||fieldAnswerByKey(answers,['signatory_capacity']),guardianName,guardianEmail,guardianSignatureText,guardianSignatureUrl,
      trim(req.body.witnessName,200),trim(req.body.witnessSignature,500),companyStampUrl,downloadToken,requestContext.current()&&requestContext.current().ip||req.ip||null,req.get('user-agent')||null,
      a.version,a.title,a.description,a.rules,a.terms,a.post_signing_requirements,a.require_witness,a.require_company_stamp,a.amount,a.payment_mode,a.service_scope,a.service_name,a.service_description,a.service_reference,a.client_name,JSON.stringify(definition)];

    let submission;
    if(provisional){const r=await client.query(`UPDATE agreement_submissions SET answers=$1,signer_name=$2,signer_email=$3,signer_type_at_signing=$4,signature_type=$5,signature_text=$6,signature_url=$7,business_signatory_capacity=$8,guardian_name=$9,guardian_email=$10,guardian_signature_text=$11,guardian_signature_url=$12,witness_name=$13,witness_signature=$14,company_stamp_url=$15,download_token=$16,ip=$17,user_agent=$18,agreement_version=$19,title_at_signing=$20,description_at_signing=$21,rules_at_signing=$22,terms_at_signing=$23,post_signing_requirements_at_signing=$24,require_witness_at_signing=$25,require_company_stamp_at_signing=$26,amount_at_signing=$27,payment_mode_at_signing=$28,service_scope_at_signing=$29,service_name_at_signing=$30,service_description_at_signing=$31,service_reference_at_signing=$32,client_name_at_signing=$33,definition_at_signing=$34,status='complete',payment_status='confirmed',signed_at=now(),submitted_at=now() WHERE id=$35 RETURNING *`,[...values,provisional.id]);submission=r.rows[0];}
    else {const paymentStatus=a.payment_mode==='after_sign'&&Number(a.amount)>0?'awaiting_payment':'not_required';const status=paymentStatus==='awaiting_payment'?'awaiting_payment':'complete';const r=await client.query(`INSERT INTO agreement_submissions(agreement_id,user_id,reference,answers,signer_name,signer_email,signer_type_at_signing,signature_type,signature_text,signature_url,business_signatory_capacity,guardian_name,guardian_email,guardian_signature_text,guardian_signature_url,witness_name,witness_signature,company_stamp_url,download_token,ip,user_agent,agreement_version,title_at_signing,description_at_signing,rules_at_signing,terms_at_signing,post_signing_requirements_at_signing,require_witness_at_signing,require_company_stamp_at_signing,amount_at_signing,payment_mode_at_signing,service_scope_at_signing,service_name_at_signing,service_description_at_signing,service_reference_at_signing,client_name_at_signing,definition_at_signing,status,payment_status,signed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,now()) RETURNING *`,[a.id,req.user?req.user.id:null,ref,...values,status,paymentStatus]);submission=r.rows[0];}

    const pdf=await generateAgreementDocument({submission,fields,client});
    if(uploads.r2PrivateConfigured){try{const url=await uploads.uploadPrivateBuffer(pdf,`agreement-${submission.reference}.pdf`,'application/pdf');const u=await client.query('UPDATE agreement_submissions SET document_url=$2 WHERE id=$1 RETURNING *',[submission.id,url]);submission=u.rows[0];}catch(err){console.error('[agreement forms] signed PDF storage failed:',err.message);}}
    res.status(201).json({submissionId:submission.id,reference:submission.reference,downloadToken:submission.download_token,signed:true,paymentRequired:submission.payment_status==='awaiting_payment',payment:{linkedType:'agreement_payment',linkedId:submission.id,amount:Number(a.amount)||0,requiresAccount:submission.payment_status==='awaiting_payment'&&!req.user},postSigningRequirements:a.post_signing_requirements||null});
  }catch(err){if(err.statusCode)return res.status(err.statusCode).json({error:err.message});next(err);}finally{client.release();}
});

router.get('/:slug/document/:submissionId', async(req,res,next)=>{
  try{
    const a=await getAgreementBySlug(req.params.slug);if(!a)return res.status(404).json({error:'Agreement not found.'});const s=await pool.query('SELECT * FROM agreement_submissions WHERE id=$1 AND agreement_id=$2 AND signed_at IS NOT NULL',[req.params.submissionId,a.id]);if(!s.rowCount)return res.status(404).json({error:'Signed record not found.'});const row=s.rows[0];
    const admin=req.user&&req.user.role==='admin';const owner=req.user&&row.user_id&&Number(req.user.id)===Number(row.user_id);const token=String(req.query.token||'');if(!admin&&!owner&&(!row.download_token||token!==row.download_token))return res.status(403).json({error:'That document link is not valid.'});
    if(row.document_url){try{const fetched=await uploads.fetchPrivateObject(row.document_url);if(fetched.ok){const buffer=Buffer.from(await fetched.arrayBuffer());return res.type('application/pdf').send(buffer);}}catch(err){console.warn('[agreement forms] stored PDF fetch failed; regenerating from snapshot:',err.message);}}
    const pdf=await buildSignedPdf(row.id);if(!pdf)return res.status(404).json({error:'Signed record not found.'});res.type('application/pdf').send(pdf);
  }catch(err){next(err);}
});

router.get('/admin/:id/submissions', requireRole('admin'), async(req,res,next)=>{try{const r=await pool.query('SELECT id,reference,signer_name,signer_email,agreement_version,status,payment_status,signed_at,submitted_at FROM agreement_submissions WHERE agreement_id=$1 ORDER BY submitted_at DESC',[req.params.id]);res.json({submissions:r.rows});}catch(err){next(err);}});

module.exports = { router, shortLinkRouter, effectiveState, validateAnswers };
