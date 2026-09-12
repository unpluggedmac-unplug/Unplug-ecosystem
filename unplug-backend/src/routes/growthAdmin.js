'use strict';

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin'));

const STATUS_VALUES = new Set([
  'draft','submitted','under_review','information_requested','assessment_in_progress',
  'plan_in_progress','in_progress','completed','withdrawn','closed','contacted','new',
]);
const FIELD_TYPES = new Set([
  'text','textarea','number','email','tel','date','url','select','multiselect','radio','checkbox','yes_no','upload',
]);

function id(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
function text(value) { return String(value == null ? '' : value).trim(); }
function bool(value, fallback = false) { return typeof value === 'boolean' ? value : fallback; }
function jsonObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function jsonArray(value) { return Array.isArray(value) ? value : []; }

async function masterForm(client = pool) {
  const result = await client.query(
    `SELECT id, slug, name, description, is_active, created_at, updated_at
       FROM growth_forms WHERE is_master = true LIMIT 1`,
  );
  return result.rows[0] || null;
}

async function versionTree(versionId, includeSensitive, client = pool) {
  const version = await client.query(
    `SELECT v.*, f.slug AS form_slug, f.name AS form_name
       FROM growth_form_versions v JOIN growth_forms f ON f.id = v.form_id
      WHERE v.id = $1`,
    [versionId],
  );
  if (!version.rowCount) return null;
  const steps = await client.query(
    `SELECT id, step_key, title, description, display_order, is_enabled
       FROM growth_form_steps WHERE version_id = $1 ORDER BY display_order, id`,
    [versionId],
  );
  const fields = await client.query(
    `SELECT f.*,
            COALESCE(jsonb_agg(jsonb_build_object(
              'id', o.id, 'value', o.option_value, 'label', o.option_label,
              'displayOrder', o.display_order, 'enabled', o.is_enabled
            ) ORDER BY o.display_order, o.id) FILTER (WHERE o.id IS NOT NULL), '[]'::jsonb) AS options
       FROM growth_form_fields f
       LEFT JOIN growth_form_field_options o ON o.field_id = f.id
      WHERE f.version_id = $1 ${includeSensitive ? '' : 'AND f.sensitive = false'}
      GROUP BY f.id ORDER BY f.step_id, f.display_order, f.id`,
    [versionId],
  );
  return { ...version.rows[0], steps: steps.rows, fields: fields.rows };
}

async function latestAnswerRows(applicationId, includeSensitive, client = pool) {
  const result = await client.query(
    `SELECT DISTINCT ON (r.field_key)
            r.field_key, r.field_id, r.value_json, r.revision_number, r.created_at,
            f.label, f.field_type, COALESCE(f.sensitive, false) AS sensitive,
            COALESCE(f.confidential, false) AS confidential
       FROM growth_application_answer_revisions r
       LEFT JOIN growth_form_fields f ON f.id = r.field_id
      WHERE r.application_id = $1 ${includeSensitive ? '' : 'AND COALESCE(f.sensitive, false) = false'}
      ORDER BY r.field_key, r.revision_number DESC`,
    [applicationId],
  );
  return result.rows;
}

router.get('/form', async (req, res, next) => {
  try {
    const form = await masterForm();
    if (!form) return res.status(404).json({ error: 'Master Growth Application form not found.' });
    const versions = await pool.query(
      `SELECT id, version_number, status, title, intro_text, consent_text,
              created_by, published_by, created_at, published_at, retired_at
         FROM growth_form_versions WHERE form_id = $1 ORDER BY version_number DESC`,
      [form.id],
    );
    return res.json({ form, versions: versions.rows });
  } catch (err) { return next(err); }
});

router.get('/versions/:versionId', async (req, res, next) => {
  const versionId = id(req.params.versionId);
  if (!versionId) return res.status(400).json({ error: 'Invalid version id.' });
  try {
    const tree = await versionTree(versionId, false);
    if (!tree) return res.status(404).json({ error: 'Form version not found.' });
    return res.json({ version: tree });
  } catch (err) { return next(err); }
});

router.get('/versions/:versionId/sensitive', async (req, res, next) => {
  const versionId = id(req.params.versionId);
  if (!versionId) return res.status(400).json({ error: 'Invalid version id.' });
  try {
    const tree = await versionTree(versionId, true);
    if (!tree) return res.status(404).json({ error: 'Form version not found.' });
    return res.json({ version: tree });
  } catch (err) { return next(err); }
});

router.post('/form/versions', async (req, res, next) => {
  const sourceVersionId = id(req.body?.sourceVersionId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const form = await masterForm(client);
    if (!form) throw new Error('Master Growth Application form not found.');
    const nextVersion = await client.query(
      `SELECT COALESCE(MAX(version_number),0)+1 AS version_number
         FROM growth_form_versions WHERE form_id = $1 FOR UPDATE`,
      [form.id],
    );
    const created = await client.query(
      `INSERT INTO growth_form_versions
         (form_id, version_number, status, title, intro_text, consent_text, created_by)
       VALUES ($1,$2,'draft',$3,$4,$5,$6)
       RETURNING *`,
      [form.id, nextVersion.rows[0].version_number,
        text(req.body?.title) || `Growth Application v${nextVersion.rows[0].version_number}`,
        text(req.body?.introText) || null, text(req.body?.consentText) || null, req.user.id],
    );
    const newVersionId = created.rows[0].id;

    if (sourceVersionId) {
      const source = await client.query(
        `SELECT id FROM growth_form_versions WHERE id=$1 AND form_id=$2`,
        [sourceVersionId, form.id],
      );
      if (!source.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Source version does not belong to the master form.' });
      }
      const oldSteps = await client.query(
        `SELECT * FROM growth_form_steps WHERE version_id=$1 ORDER BY display_order,id`, [sourceVersionId]);
      for (const oldStep of oldSteps.rows) {
        const newStep = await client.query(
          `INSERT INTO growth_form_steps(version_id,step_key,title,description,display_order,is_enabled)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [newVersionId, oldStep.step_key, oldStep.title, oldStep.description, oldStep.display_order, oldStep.is_enabled],
        );
        const oldFields = await client.query(
          `SELECT * FROM growth_form_fields WHERE step_id=$1 ORDER BY display_order,id`, [oldStep.id]);
        for (const oldField of oldFields.rows) {
          const newField = await client.query(
            `INSERT INTO growth_form_fields
              (version_id,step_id,field_key,label,help_text,placeholder,field_type,display_order,
               is_required,is_enabled,sensitive,sensitive_enabled,confidential,allow_external_sharing,
               applicant_types,validation_rules,visibility_rules)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb)
             RETURNING id`,
            [newVersionId, newStep.rows[0].id, oldField.field_key, oldField.label, oldField.help_text,
              oldField.placeholder, oldField.field_type, oldField.display_order, oldField.is_required,
              oldField.is_enabled, oldField.sensitive, oldField.sensitive_enabled, oldField.confidential,
              oldField.allow_external_sharing, JSON.stringify(oldField.applicant_types),
              JSON.stringify(oldField.validation_rules), JSON.stringify(oldField.visibility_rules)],
          );
          await client.query(
            `INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order,is_enabled)
             SELECT $1, option_value, option_label, display_order, is_enabled
               FROM growth_form_field_options WHERE field_id=$2`,
            [newField.rows[0].id, oldField.id],
          );
        }
      }
    }
    await client.query('COMMIT');
    return res.status(201).json({ version: created.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.patch('/versions/:versionId', async (req, res, next) => {
  const versionId = id(req.params.versionId);
  if (!versionId) return res.status(400).json({ error: 'Invalid version id.' });
  try {
    const result = await pool.query(
      `UPDATE growth_form_versions
          SET title=COALESCE(NULLIF($2,''),title),
              intro_text=CASE WHEN $3::boolean THEN $4 ELSE intro_text END,
              consent_text=CASE WHEN $5::boolean THEN $6 ELSE consent_text END
        WHERE id=$1 AND status='draft'
        RETURNING *`,
      [versionId, text(req.body?.title), Object.prototype.hasOwnProperty.call(req.body || {}, 'introText'),
        text(req.body?.introText) || null, Object.prototype.hasOwnProperty.call(req.body || {}, 'consentText'),
        text(req.body?.consentText) || null],
    );
    if (!result.rowCount) return res.status(409).json({ error: 'Only a draft version can be edited.' });
    return res.json({ version: result.rows[0] });
  } catch (err) { return next(err); }
});

router.post('/versions/:versionId/steps', async (req, res, next) => {
  const versionId = id(req.params.versionId);
  const stepKey = text(req.body?.stepKey).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const title = text(req.body?.title);
  if (!versionId || !stepKey || !title) return res.status(400).json({ error: 'versionId, stepKey and title are required.' });
  try {
    const result = await pool.query(
      `INSERT INTO growth_form_steps(version_id,step_key,title,description,display_order,is_enabled)
       SELECT $1,$2,$3,$4,$5,$6
        WHERE EXISTS (SELECT 1 FROM growth_form_versions WHERE id=$1 AND status='draft')
       RETURNING *`,
      [versionId, stepKey, title, text(req.body?.description) || null,
        Number.isInteger(req.body?.displayOrder) ? req.body.displayOrder : 0, bool(req.body?.enabled, true)],
    );
    if (!result.rowCount) return res.status(409).json({ error: 'Steps can only be added to a draft version.' });
    return res.status(201).json({ step: result.rows[0] });
  } catch (err) { return next(err); }
});

router.patch('/steps/:stepId', async (req, res, next) => {
  const stepId = id(req.params.stepId);
  if (!stepId) return res.status(400).json({ error: 'Invalid step id.' });
  try {
    const result = await pool.query(
      `UPDATE growth_form_steps s
          SET title=COALESCE(NULLIF($2,''),s.title),
              description=CASE WHEN $3::boolean THEN $4 ELSE s.description END,
              display_order=COALESCE($5,s.display_order),
              is_enabled=COALESCE($6,s.is_enabled)
         FROM growth_form_versions v
        WHERE s.id=$1 AND v.id=s.version_id AND v.status='draft'
        RETURNING s.*`,
      [stepId, text(req.body?.title), Object.prototype.hasOwnProperty.call(req.body || {}, 'description'),
        text(req.body?.description) || null, Number.isInteger(req.body?.displayOrder) ? req.body.displayOrder : null,
        typeof req.body?.enabled === 'boolean' ? req.body.enabled : null],
    );
    if (!result.rowCount) return res.status(409).json({ error: 'Only steps in a draft version can be edited.' });
    return res.json({ step: result.rows[0] });
  } catch (err) { return next(err); }
});

router.post('/steps/:stepId/fields', async (req, res, next) => {
  const stepId = id(req.params.stepId);
  const fieldKey = text(req.body?.fieldKey).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const label = text(req.body?.label);
  const fieldType = text(req.body?.fieldType);
  const sensitive = bool(req.body?.sensitive, false);
  const sensitiveEnabled = sensitive ? bool(req.body?.sensitiveEnabled, false) : false;
  const enabled = sensitive && !sensitiveEnabled ? false : bool(req.body?.enabled, true);
  if (!stepId || !fieldKey || !label || !FIELD_TYPES.has(fieldType)) {
    return res.status(400).json({ error: 'stepId, fieldKey, label and a valid fieldType are required.' });
  }
  const applicantTypes = jsonArray(req.body?.applicantTypes).filter((x) => ['individual','business'].includes(x));
  if (!applicantTypes.length) applicantTypes.push('individual','business');
  try {
    const result = await pool.query(
      `INSERT INTO growth_form_fields
        (version_id,step_id,field_key,label,help_text,placeholder,field_type,display_order,
         is_required,is_enabled,sensitive,sensitive_enabled,confidential,allow_external_sharing,
         applicant_types,validation_rules,visibility_rules)
       SELECT s.version_id,s.id,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb
         FROM growth_form_steps s JOIN growth_form_versions v ON v.id=s.version_id
        WHERE s.id=$1 AND v.status='draft'
       RETURNING *`,
      [stepId, fieldKey, label, text(req.body?.helpText) || null, text(req.body?.placeholder) || null,
        fieldType, Number.isInteger(req.body?.displayOrder) ? req.body.displayOrder : 0,
        bool(req.body?.required, false), enabled, sensitive, sensitiveEnabled,
        bool(req.body?.confidential, false), bool(req.body?.allowExternalSharing, false),
        JSON.stringify(applicantTypes), JSON.stringify(jsonObject(req.body?.validationRules)),
        JSON.stringify(jsonObject(req.body?.visibilityRules))],
    );
    if (!result.rowCount) return res.status(409).json({ error: 'Fields can only be added to a draft version.' });
    return res.status(201).json({ field: result.rows[0] });
  } catch (err) { return next(err); }
});

router.patch('/fields/:fieldId', async (req, res, next) => {
  const fieldId = id(req.params.fieldId);
  if (!fieldId) return res.status(400).json({ error: 'Invalid field id.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT f.*, v.status AS version_status
         FROM growth_form_fields f JOIN growth_form_versions v ON v.id=f.version_id
        WHERE f.id=$1 FOR UPDATE`, [fieldId]);
    if (!current.rowCount || current.rows[0].version_status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only fields in a draft version can be edited.' });
    }
    const row = current.rows[0];
    const fieldType = req.body?.fieldType == null ? row.field_type : text(req.body.fieldType);
    if (!FIELD_TYPES.has(fieldType)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid field type.' });
    }
    const sensitive = typeof req.body?.sensitive === 'boolean' ? req.body.sensitive : row.sensitive;
    const sensitiveEnabled = sensitive
      ? (typeof req.body?.sensitiveEnabled === 'boolean' ? req.body.sensitiveEnabled : row.sensitive_enabled)
      : false;
    let enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : row.is_enabled;
    if (sensitive && !sensitiveEnabled) enabled = false;
    const applicantTypes = req.body?.applicantTypes == null ? row.applicant_types
      : jsonArray(req.body.applicantTypes).filter((x) => ['individual','business'].includes(x));
    if (!applicantTypes.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'At least one applicant type is required.' });
    }
    const updated = await client.query(
      `UPDATE growth_form_fields SET
         label=$2, help_text=$3, placeholder=$4, field_type=$5, display_order=$6,
         is_required=$7, is_enabled=$8, sensitive=$9, sensitive_enabled=$10,
         confidential=$11, allow_external_sharing=$12, applicant_types=$13::jsonb,
         validation_rules=$14::jsonb, visibility_rules=$15::jsonb
       WHERE id=$1 RETURNING *`,
      [fieldId, text(req.body?.label) || row.label,
        Object.prototype.hasOwnProperty.call(req.body || {}, 'helpText') ? text(req.body.helpText) || null : row.help_text,
        Object.prototype.hasOwnProperty.call(req.body || {}, 'placeholder') ? text(req.body.placeholder) || null : row.placeholder,
        fieldType, Number.isInteger(req.body?.displayOrder) ? req.body.displayOrder : row.display_order,
        typeof req.body?.required === 'boolean' ? req.body.required : row.is_required, enabled, sensitive, sensitiveEnabled,
        typeof req.body?.confidential === 'boolean' ? req.body.confidential : row.confidential,
        typeof req.body?.allowExternalSharing === 'boolean' ? req.body.allowExternalSharing : row.allow_external_sharing,
        JSON.stringify(applicantTypes), JSON.stringify(req.body?.validationRules == null ? row.validation_rules : jsonObject(req.body.validationRules)),
        JSON.stringify(req.body?.visibilityRules == null ? row.visibility_rules : jsonObject(req.body.visibilityRules))],
    );
    await client.query('COMMIT');
    return res.json({ field: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.post('/fields/:fieldId/options', async (req, res, next) => {
  const fieldId = id(req.params.fieldId);
  const optionValue = text(req.body?.value);
  const optionLabel = text(req.body?.label);
  if (!fieldId || !optionValue || !optionLabel) return res.status(400).json({ error: 'value and label are required.' });
  try {
    const result = await pool.query(
      `INSERT INTO growth_form_field_options(field_id,option_value,option_label,display_order,is_enabled)
       SELECT f.id,$2,$3,$4,$5 FROM growth_form_fields f
       JOIN growth_form_versions v ON v.id=f.version_id
       WHERE f.id=$1 AND v.status='draft'
       RETURNING *`,
      [fieldId, optionValue, optionLabel, Number.isInteger(req.body?.displayOrder) ? req.body.displayOrder : 0, bool(req.body?.enabled, true)],
    );
    if (!result.rowCount) return res.status(409).json({ error: 'Options can only be added to draft fields.' });
    return res.status(201).json({ option: result.rows[0] });
  } catch (err) { return next(err); }
});

router.post('/versions/:versionId/publish', async (req, res, next) => {
  const versionId = id(req.params.versionId);
  if (!versionId) return res.status(400).json({ error: 'Invalid version id.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query(
      `SELECT * FROM growth_form_versions WHERE id=$1 FOR UPDATE`, [versionId]);
    if (!target.rowCount || target.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only a draft version can be published.' });
    }
    const counts = await client.query(
      `SELECT COUNT(DISTINCT s.id)::int AS steps, COUNT(f.id)::int AS fields
         FROM growth_form_steps s LEFT JOIN growth_form_fields f ON f.step_id=s.id AND f.is_enabled=true
        WHERE s.version_id=$1 AND s.is_enabled=true`, [versionId]);
    if (!counts.rows[0].steps || !counts.rows[0].fields) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A published Growth form needs at least one enabled step and field.' });
    }
    await client.query(
      `UPDATE growth_form_versions SET status='retired', retired_at=now()
        WHERE form_id=$1 AND status='published'`, [target.rows[0].form_id]);
    const published = await client.query(
      `UPDATE growth_form_versions SET status='published', published_at=now(), published_by=$2
        WHERE id=$1 RETURNING *`, [versionId, req.user.id]);
    await client.query('COMMIT');
    return res.json({ version: published.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.get('/applications', async (req, res, next) => {
  try {
    const statuses = text(req.query.status).split(',').map((x) => x.trim()).filter((x) => STATUS_VALUES.has(x));
    const params = [];
    let where = '';
    if (statuses.length) { params.push(statuses); where = `WHERE a.status = ANY($${params.length}::text[])`; }
    const result = await pool.query(
      `SELECT a.id, a.user_id, a.applicant_email, a.applicant_type, a.status,
              a.completion_percent, a.submitted_at, a.withdrawn_at, a.created_at, a.updated_at,
              u.name AS member_name, u.email AS member_email
         FROM growth_applications a LEFT JOIN users u ON u.id=a.user_id
         ${where}
        ORDER BY a.updated_at DESC LIMIT 250`, params);
    return res.json({ applications: result.rows });
  } catch (err) { return next(err); }
});

async function applicationDetail(applicationId, includeSensitive) {
  const appResult = await pool.query(
    `SELECT a.*, u.name AS member_name, u.email AS member_email
       FROM growth_applications a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.id=$1`, [applicationId]);
  if (!appResult.rowCount) return null;
  const [answers, requests, assessment, priorities, opportunities, plan, progress, outcome, links, reopens, history] = await Promise.all([
    latestAnswerRows(applicationId, includeSensitive),
    pool.query(`SELECT * FROM growth_information_requests WHERE application_id=$1 ORDER BY requested_at DESC`, [applicationId]),
    pool.query(`SELECT * FROM growth_assessments WHERE application_id=$1`, [applicationId]),
    pool.query(`SELECT * FROM growth_priorities WHERE application_id=$1 ORDER BY priority_order,id`, [applicationId]),
    pool.query(`SELECT * FROM growth_opportunities WHERE application_id=$1 ORDER BY created_at DESC`, [applicationId]),
    pool.query(`SELECT * FROM growth_plans WHERE application_id=$1`, [applicationId]),
    pool.query(`SELECT * FROM growth_progress_updates WHERE application_id=$1 ORDER BY created_at DESC`, [applicationId]),
    pool.query(`SELECT * FROM growth_outcomes WHERE application_id=$1`, [applicationId]),
    pool.query(`SELECT * FROM growth_application_entity_links WHERE application_id=$1 ORDER BY created_at DESC`, [applicationId]),
    pool.query(`SELECT * FROM growth_application_field_reopens WHERE application_id=$1 ORDER BY opened_at DESC`, [applicationId]),
    pool.query(`SELECT * FROM growth_status_history WHERE application_id=$1 ORDER BY created_at DESC`, [applicationId]),
  ]);
  let planPayload = plan.rows[0] || null;
  if (planPayload) {
    const items = await pool.query(`SELECT * FROM growth_plan_items WHERE plan_id=$1 ORDER BY display_order,id`, [planPayload.id]);
    planPayload = { ...planPayload, items: items.rows };
  }
  return {
    application: appResult.rows[0], answers, informationRequests: requests.rows,
    assessment: assessment.rows[0] || null, priorities: priorities.rows, opportunities: opportunities.rows,
    growthPlan: planPayload, progress: progress.rows, outcome: outcome.rows[0] || null,
    entityLinks: links.rows, reopenedFields: reopens.rows, statusHistory: history.rows,
  };
}

router.get('/applications/:applicationId', async (req, res, next) => {
  const applicationId = id(req.params.applicationId);
  if (!applicationId) return res.status(400).json({ error: 'Invalid application id.' });
  try {
    const detail = await applicationDetail(applicationId, false);
    if (!detail) return res.status(404).json({ error: 'Growth Application not found.' });
    return res.json(detail);
  } catch (err) { return next(err); }
});

router.get('/applications/:applicationId/sensitive', async (req, res, next) => {
  const applicationId = id(req.params.applicationId);
  if (!applicationId) return res.status(400).json({ error: 'Invalid application id.' });
  try {
    const detail = await applicationDetail(applicationId, true);
    if (!detail) return res.status(404).json({ error: 'Growth Application not found.' });
    const uploads = await pool.query(`SELECT * FROM growth_uploads WHERE application_id=$1 ORDER BY created_at DESC`, [applicationId]);
    return res.json({ ...detail, uploads: uploads.rows });
  } catch (err) { return next(err); }
});

router.post('/applications/:applicationId/status', async (req, res, next) => {
  const applicationId = id(req.params.applicationId);
  const nextStatus = text(req.body?.status);
  if (!applicationId || !STATUS_VALUES.has(nextStatus) || nextStatus === 'draft') {
    return res.status(400).json({ error: 'Provide a valid admin status.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT status FROM growth_applications WHERE id=$1 FOR UPDATE`, [applicationId]);
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Growth Application not found.' });
    }
    await client.query(
      `UPDATE growth_applications SET status=$2, closed_at=CASE WHEN $2 IN ('completed','closed') THEN now() ELSE closed_at END, updated_at=now() WHERE id=$1`,
      [applicationId, nextStatus]);
    await client.query(
      `INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,note)
       VALUES($1,$2,$3,$4,$5)`,
      [applicationId, current.rows[0].status, nextStatus, req.user.id, text(req.body?.note) || null]);
    await client.query('COMMIT');
    return res.json({ application: { id: applicationId, status: nextStatus } });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.post('/applications/:applicationId/reopen-field', async (req, res, next) => {
  const applicationId = id(req.params.applicationId);
  const fieldKey = text(req.body?.fieldKey);
  if (!applicationId || !fieldKey) return res.status(400).json({ error: 'fieldKey is required.' });
  try {
    const valid = await pool.query(
      `SELECT 1 FROM growth_applications a JOIN growth_form_fields f ON f.version_id=a.form_version_id
        WHERE a.id=$1 AND f.field_key=$2`, [applicationId, fieldKey]);
    if (!valid.rowCount) return res.status(400).json({ error: 'That field does not belong to this application version.' });
    const result = await pool.query(
      `INSERT INTO growth_application_field_reopens(application_id,field_key,reason,opened_by)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [applicationId, fieldKey, text(req.body?.reason) || null, req.user.id]);
    return res.status(201).json({ reopen: result.rows[0] });
  } catch (err) { return next(err); }
});

router.post('/applications/:applicationId/information-requests', async (req, res, next) => {
  const applicationId = id(req.params.applicationId);
  const requestText = text(req.body?.requestText);
  if (!applicationId || !requestText) return res.status(400).json({ error: 'requestText is required.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const appResult = await client.query(`SELECT status FROM growth_applications WHERE id=$1 FOR UPDATE`, [applicationId]);
    if (!appResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Growth Application not found.' });
    }
    const created = await client.query(
      `INSERT INTO growth_information_requests(application_id,request_text,requested_fields,requested_by)
       VALUES($1,$2,$3::jsonb,$4) RETURNING *`,
      [applicationId, requestText, JSON.stringify(jsonArray(req.body?.requestedFields)), req.user.id]);
    if (!['withdrawn','completed','closed'].includes(appResult.rows[0].status)) {
      await client.query(`UPDATE growth_applications SET status='information_requested',updated_at=now() WHERE id=$1`, [applicationId]);
      await client.query(
        `INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,note)
         VALUES($1,$2,'information_requested',$3,'Additional information requested')`,
        [applicationId, appResult.rows[0].status, req.user.id]);
    }
    await client.query('COMMIT');
    return res.status(201).json({ request: created.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.put('/applications/:applicationId/assessment', async (req, res, next) => {
  const applicationId = id(req.params.applicationId);
  if (!applicationId) return res.status(400).json({ error: 'Invalid application id.' });
  const score = (key) => req.body?.[key] == null ? null : Number(req.body[key]);
  const scores = ['readinessScore','credibilityScore','exposureScore','opportunityScore','growthScore'].map(score);
  if (scores.some((x) => x != null && (!Number.isFinite(x) || x < 0 || x > 100))) {
    return res.status(400).json({ error: 'Assessment scores must be between 0 and 100.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO growth_assessments
        (application_id,strengths,challenges,readiness_score,credibility_score,exposure_score,
         opportunity_score,growth_score,internal_notes,assessed_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(application_id) DO UPDATE SET
         strengths=EXCLUDED.strengths,challenges=EXCLUDED.challenges,readiness_score=EXCLUDED.readiness_score,
         credibility_score=EXCLUDED.credibility_score,exposure_score=EXCLUDED.exposure_score,
         opportunity_score=EXCLUDED.opportunity_score,growth_score=EXCLUDED.growth_score,
         internal_notes=EXCLUDED.internal_notes,assessed_by=EXCLUDED.assessed_by,updated_at=now()
       RETURNING *`,
      [applicationId, text(req.body?.strengths) || null, text(req.body?.challenges) || null,
        ...scores, text(req.body?.internalNotes) || null, req.user.id],
    );
    return res.json({ assessment: result.rows[0] });
  } catch (err) { return next(err); }
});

router.post('/applications/:applicationId/priorities', async (req, res, next) => {
  const applicationId = id(req.params.applicationId); const title = text(req.body?.title);
  if (!applicationId || !title) return res.status(400).json({ error: 'title is required.' });
  try {
    const result = await pool.query(
      `INSERT INTO growth_priorities(application_id,title,detail,priority_order,created_by)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [applicationId, title, text(req.body?.detail) || null, Number.isInteger(req.body?.priorityOrder) ? req.body.priorityOrder : 0, req.user.id]);
    return res.status(201).json({ priority: result.rows[0] });
  } catch (err) { return next(err); }
});

router.post('/applications/:applicationId/opportunities', async (req, res, next) => {
  const applicationId = id(req.params.applicationId); const title = text(req.body?.title);
  if (!applicationId || !title) return res.status(400).json({ error: 'title is required.' });
  try {
    const result = await pool.query(
      `INSERT INTO growth_opportunities(application_id,title,detail,opportunity_type,internal_only,created_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [applicationId, title, text(req.body?.detail) || null, text(req.body?.opportunityType) || null,
        bool(req.body?.internalOnly, true), req.user.id]);
    return res.status(201).json({ opportunity: result.rows[0] });
  } catch (err) { return next(err); }
});

router.put('/applications/:applicationId/growth-plan', async (req, res, next) => {
  const applicationId = id(req.params.applicationId);
  if (!applicationId) return res.status(400).json({ error: 'Invalid application id.' });
  try {
    const result = await pool.query(
      `INSERT INTO growth_plans(application_id,objective,strategy,internal_notes,status,review_at,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT(application_id) DO UPDATE SET
         objective=EXCLUDED.objective,strategy=EXCLUDED.strategy,internal_notes=EXCLUDED.internal_notes,
         status=EXCLUDED.status,review_at=EXCLUDED.review_at,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING *`,
      [applicationId, text(req.body?.objective) || null, text(req.body?.strategy) || null,
        text(req.body?.internalNotes) || null,
        ['draft','active','paused','completed','archived'].includes(req.body?.status) ? req.body.status : 'draft',
        req.body?.reviewAt || null, req.user.id]);
    return res.json({ growthPlan: result.rows[0] });
  } catch (err) { return next(err); }
});

router.post('/growth-plans/:planId/items', async (req, res, next) => {
  const planId = id(req.params.planId); const title = text(req.body?.title);
  if (!planId || !title) return res.status(400).json({ error: 'title is required.' });
  try {
    const result = await pool.query(
      `INSERT INTO growth_plan_items(plan_id,title,description,owner_user_id,due_date,display_order,status)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [planId, title, text(req.body?.description) || null, id(req.body?.ownerUserId), req.body?.dueDate || null,
        Number.isInteger(req.body?.displayOrder) ? req.body.displayOrder : 0,
        ['not_started','in_progress','blocked','completed','cancelled'].includes(req.body?.status) ? req.body.status : 'not_started']);
    return res.status(201).json({ item: result.rows[0] });
  } catch (err) { return next(err); }
});

router.post('/applications/:applicationId/progress', async (req, res, next) => {
  const applicationId = id(req.params.applicationId); const updateText = text(req.body?.updateText);
  if (!applicationId || !updateText) return res.status(400).json({ error: 'updateText is required.' });
  try {
    const result = await pool.query(
      `INSERT INTO growth_progress_updates(application_id,update_text,internal_only,created_by)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [applicationId, updateText, bool(req.body?.internalOnly, true), req.user.id]);
    return res.status(201).json({ progress: result.rows[0] });
  } catch (err) { return next(err); }
});

router.put('/applications/:applicationId/outcome', async (req, res, next) => {
  const applicationId = id(req.params.applicationId);
  if (!applicationId) return res.status(400).json({ error: 'Invalid application id.' });
  try {
    const result = await pool.query(
      `INSERT INTO growth_outcomes(application_id,outcome_summary,outcome_code,future_review_at,internal_notes,closed_by)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(application_id) DO UPDATE SET
         outcome_summary=EXCLUDED.outcome_summary,outcome_code=EXCLUDED.outcome_code,
         future_review_at=EXCLUDED.future_review_at,internal_notes=EXCLUDED.internal_notes,
         closed_by=EXCLUDED.closed_by,updated_at=now()
       RETURNING *`,
      [applicationId, text(req.body?.summary) || null, text(req.body?.code) || null,
        req.body?.futureReviewAt || null, text(req.body?.internalNotes) || null, req.user.id]);
    return res.json({ outcome: result.rows[0] });
  } catch (err) { return next(err); }
});

router.post('/applications/:applicationId/entity-links', async (req, res, next) => {
  const applicationId = id(req.params.applicationId);
  const entityType = text(req.body?.entityType); const entityId = text(req.body?.entityId);
  const validTypes = ['member','business','opportunity','service_order','campaign','agreement'];
  if (!applicationId || !validTypes.includes(entityType) || !entityId) {
    return res.status(400).json({ error: 'Provide a valid entityType and entityId.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO growth_application_entity_links(application_id,entity_type,entity_id,relationship,created_by)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(application_id,entity_type,entity_id) DO UPDATE SET relationship=EXCLUDED.relationship
       RETURNING *`,
      [applicationId, entityType, entityId, text(req.body?.relationship) || null, req.user.id]);
    return res.status(201).json({ link: result.rows[0] });
  } catch (err) { return next(err); }
});

module.exports = router;
