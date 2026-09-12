'use strict';

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MEMBER_STATUSES = new Set([
  'draft','submitted','under_review','information_requested','assessment_in_progress',
  'plan_in_progress','in_progress','completed','withdrawn','closed','contacted','new',
]);

function intId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isEmptyValue(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

async function ownedApplication(applicationId, userId, client = pool) {
  const result = await client.query(
    `SELECT id, user_id, applicant_email, applicant_type, status, form_version_id,
            completion_percent, last_saved_at, submitted_at, locked_at,
            withdrawn_at, external_sharing_allowed, external_sharing_consent_at,
            created_at, updated_at
       FROM growth_applications
      WHERE id = $1 AND user_id = $2`,
    [applicationId, userId],
  );
  return result.rows[0] || null;
}

async function activeMasterForm(applicantType, client = pool) {
  const version = await client.query(
    `SELECT v.id, v.version_number, v.title, v.intro_text, v.consent_text,
            f.id AS form_id, f.slug, f.name
       FROM growth_forms f
       JOIN growth_form_versions v ON v.form_id = f.id
      WHERE f.is_master = true AND f.is_active = true AND v.status = 'published'
      ORDER BY v.version_number DESC
      LIMIT 1`,
  );
  if (!version.rowCount) return null;

  const steps = await client.query(
    `SELECT id, step_key, title, description, display_order
       FROM growth_form_steps
      WHERE version_id = $1 AND is_enabled = true
      ORDER BY display_order, id`,
    [version.rows[0].id],
  );

  const fields = await client.query(
    `SELECT f.id, f.step_id, f.field_key, f.label, f.help_text, f.placeholder,
            f.field_type, f.display_order, f.is_required, f.sensitive,
            f.confidential, f.allow_external_sharing, f.validation_rules, f.visibility_rules,
            COALESCE(jsonb_agg(jsonb_build_object(
              'value', o.option_value, 'label', o.option_label, 'displayOrder', o.display_order
            ) ORDER BY o.display_order, o.id) FILTER (WHERE o.id IS NOT NULL), '[]'::jsonb) AS options
       FROM growth_form_fields f
       LEFT JOIN growth_form_field_options o ON o.field_id = f.id AND o.is_enabled = true
      WHERE f.version_id = $1
        AND f.is_enabled = true
        AND (f.sensitive = false OR f.sensitive_enabled = true)
        AND f.applicant_types ? $2
      GROUP BY f.id
      ORDER BY f.step_id, f.display_order, f.id`,
    [version.rows[0].id, applicantType],
  );

  return { ...version.rows[0], steps: steps.rows, fields: fields.rows };
}

async function formForVersion(versionId, applicantType, client = pool) {
  const version = await client.query(
    `SELECT v.id, v.version_number, v.title, v.intro_text, v.consent_text,
            f.id AS form_id, f.slug, f.name
       FROM growth_form_versions v
       JOIN growth_forms f ON f.id = v.form_id
      WHERE v.id = $1`,
    [versionId],
  );
  if (!version.rowCount) return null;

  const steps = await client.query(
    `SELECT id, step_key, title, description, display_order
       FROM growth_form_steps
      WHERE version_id = $1 AND is_enabled = true
      ORDER BY display_order, id`,
    [versionId],
  );
  const fields = await client.query(
    `SELECT f.id, f.step_id, f.field_key, f.label, f.help_text, f.placeholder,
            f.field_type, f.display_order, f.is_required, f.sensitive,
            f.confidential, f.allow_external_sharing, f.validation_rules, f.visibility_rules,
            COALESCE(jsonb_agg(jsonb_build_object(
              'value', o.option_value, 'label', o.option_label, 'displayOrder', o.display_order
            ) ORDER BY o.display_order, o.id) FILTER (WHERE o.id IS NOT NULL), '[]'::jsonb) AS options
       FROM growth_form_fields f
       LEFT JOIN growth_form_field_options o ON o.field_id = f.id AND o.is_enabled = true
      WHERE f.version_id = $1
        AND f.is_enabled = true
        AND (f.sensitive = false OR f.sensitive_enabled = true)
        AND f.applicant_types ? $2
      GROUP BY f.id
      ORDER BY f.step_id, f.display_order, f.id`,
    [versionId, applicantType],
  );
  return { ...version.rows[0], steps: steps.rows, fields: fields.rows };
}

async function latestAnswers(applicationId, client = pool) {
  const result = await client.query(
    `SELECT DISTINCT ON (field_key)
            field_key, field_id, value_json, revision_number, created_at
       FROM growth_application_answer_revisions
      WHERE application_id = $1
      ORDER BY field_key, revision_number DESC`,
    [applicationId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.field_key, {
    value: row.value_json,
    revision: row.revision_number,
    savedAt: row.created_at,
  }]));
}

async function memberInformationRequests(applicationId, client = pool) {
  const result = await client.query(
    `SELECT r.id, r.request_text, r.requested_fields, r.status, r.requested_at,
            r.responded_at, r.closed_at,
            COALESCE(jsonb_agg(jsonb_build_object(
              'id', x.id, 'responseText', x.response_text, 'responseData', x.response_data,
              'createdAt', x.created_at
            ) ORDER BY x.created_at) FILTER (WHERE x.id IS NOT NULL), '[]'::jsonb) AS responses
       FROM growth_information_requests r
       LEFT JOIN growth_information_responses x ON x.request_id = r.id
      WHERE r.application_id = $1
      GROUP BY r.id
      ORDER BY r.requested_at DESC`,
    [applicationId],
  );
  return result.rows;
}

router.get('/form', async (req, res, next) => {
  try {
    const applicantType = req.query.applicantType === 'business' ? 'business' : 'individual';
    const form = await activeMasterForm(applicantType);
    if (!form) return res.status(409).json({ error: 'The Growth Application is not currently open for new applications.' });
    return res.json({ form });
  } catch (err) { return next(err); }
});

router.get('/applications', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, applicant_type, status, completion_percent, last_saved_at,
              submitted_at, withdrawn_at, created_at, updated_at
         FROM growth_applications
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id],
    );
    return res.json({ applications: result.rows });
  } catch (err) { return next(err); }
});

router.post('/applications', async (req, res, next) => {
  const applicantType = req.body && req.body.applicantType;
  if (!['individual', 'business'].includes(applicantType)) {
    return res.status(400).json({ error: 'Choose whether this application is for an individual or business.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const form = await activeMasterForm(applicantType, client);
    if (!form) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The Growth Application is not currently open for new applications.' });
    }
    const created = await client.query(
      `INSERT INTO growth_applications
         (user_id, applicant_email, applicant_type, status, form_version_id,
          current_stage, question_bank_version, last_saved_at)
       VALUES ($1,$2,$3,'draft',$4,'quick_profile',$5,now())
       RETURNING id, applicant_type, status, form_version_id, completion_percent,
                 last_saved_at, created_at, updated_at`,
      [req.user.id, req.user.email, applicantType, form.id, `growth-v2-${form.version_number}`],
    );
    await client.query(
      `INSERT INTO growth_status_history(application_id, from_status, to_status, changed_by, note)
       VALUES ($1,NULL,'draft',$2,'Application created')`,
      [created.rows[0].id, req.user.id],
    );
    await client.query('COMMIT');
    return res.status(201).json({ application: created.rows[0], form });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.get('/applications/:id', async (req, res, next) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid application id.' });
  try {
    const application = await ownedApplication(id, req.user.id);
    if (!application) return res.status(404).json({ error: 'Growth Application not found.' });
    const requests = await memberInformationRequests(id);

    // Submitted applications deliberately return status/request information only.
    // Assessment, scoring, opportunities, plan and internal notes never enter this response.
    if (application.status !== 'draft') {
      const reopens = await pool.query(
        `SELECT field_key, reason, opened_at
           FROM growth_application_field_reopens
          WHERE application_id = $1 AND closed_at IS NULL
          ORDER BY opened_at`,
        [id],
      );
      const payload = { application, informationRequests: requests, reopenedFields: reopens.rows };
      if (reopens.rowCount) {
        payload.form = await formForVersion(application.form_version_id, application.applicant_type);
        payload.answers = await latestAnswers(id);
      }
      return res.json(payload);
    }

    const form = await formForVersion(application.form_version_id, application.applicant_type);
    const answers = await latestAnswers(id);
    return res.json({ application, form, answers, informationRequests: requests });
  } catch (err) { return next(err); }
});

router.put('/applications/:id/answers', async (req, res, next) => {
  const id = intId(req.params.id);
  const answers = req.body && req.body.answers;
  if (!id || !answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return res.status(400).json({ error: 'Provide answers as an object keyed by field key.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query(
      `SELECT * FROM growth_applications WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, req.user.id],
    );
    if (!lock.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Growth Application not found.' });
    }
    const application = lock.rows[0];
    if (application.status === 'withdrawn' || application.status === 'completed' || application.status === 'closed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This Growth Application can no longer be edited.' });
    }

    const keys = Object.keys(answers);
    if (!keys.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No answers were supplied.' });
    }
    const allowed = await client.query(
      `SELECT id, field_key
         FROM growth_form_fields
        WHERE version_id = $1 AND is_enabled = true
          AND (sensitive = false OR sensitive_enabled = true)
          AND applicant_types ? $2
          AND field_key = ANY($3::text[])`,
      [application.form_version_id, application.applicant_type, keys],
    );
    const allowedMap = new Map(allowed.rows.map((row) => [row.field_key, row.id]));
    if (allowedMap.size !== keys.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'One or more fields are not valid for this application.' });
    }

    let reopenSet = new Set();
    if (application.status !== 'draft') {
      const reopened = await client.query(
        `SELECT field_key FROM growth_application_field_reopens
          WHERE application_id = $1 AND closed_at IS NULL AND field_key = ANY($2::text[])`,
        [id, keys],
      );
      reopenSet = new Set(reopened.rows.map((row) => row.field_key));
      if (reopenSet.size !== keys.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Only fields specifically reopened by Unplug can be edited after submission.' });
      }
    }

    for (const fieldKey of keys) {
      const revision = await client.query(
        `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next_revision
           FROM growth_application_answer_revisions
          WHERE application_id = $1 AND field_key = $2`,
        [id, fieldKey],
      );
      await client.query(
        `INSERT INTO growth_application_answer_revisions
           (application_id, field_id, field_key, revision_number, value_json, saved_by, save_source)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [id, allowedMap.get(fieldKey), fieldKey, revision.rows[0].next_revision,
          JSON.stringify(answers[fieldKey]), req.user.id,
          application.status === 'draft' ? 'member' : 'admin_reopen'],
      );
    }

    if (application.status !== 'draft') {
      await client.query(
        `UPDATE growth_application_field_reopens SET closed_at = now()
          WHERE application_id = $1 AND closed_at IS NULL AND field_key = ANY($2::text[])`,
        [id, keys],
      );
    }

    const required = await client.query(
      `SELECT field_key FROM growth_form_fields
        WHERE version_id = $1 AND is_enabled = true AND is_required = true
          AND (sensitive = false OR sensitive_enabled = true)
          AND applicant_types ? $2`,
      [application.form_version_id, application.applicant_type],
    );
    const current = await latestAnswers(id, client);
    const completed = required.rows.filter((row) => current[row.field_key] && !isEmptyValue(current[row.field_key].value)).length;
    const percent = required.rowCount ? Math.round((completed / required.rowCount) * 100) : 100;
    await client.query(
      `UPDATE growth_applications
          SET completion_percent = $2, last_saved_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, percent],
    );
    await client.query('COMMIT');
    return res.json({ saved: keys, completionPercent: percent, answers: current });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.patch('/applications/:id/external-sharing', async (req, res, next) => {
  const id = intId(req.params.id);
  if (!id || typeof req.body?.allowed !== 'boolean') return res.status(400).json({ error: 'Provide allowed=true or false.' });
  try {
    const result = await pool.query(
      `UPDATE growth_applications
          SET external_sharing_allowed = $3,
              external_sharing_consent_at = CASE WHEN $3 THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'draft'
        RETURNING id, external_sharing_allowed, external_sharing_consent_at`,
      [id, req.user.id, req.body.allowed],
    );
    if (!result.rowCount) return res.status(409).json({ error: 'External-sharing consent can only be changed while the application is a draft.' });
    return res.json(result.rows[0]);
  } catch (err) { return next(err); }
});

router.post('/applications/:id/submit', async (req, res, next) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid application id.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query(
      `SELECT * FROM growth_applications WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, req.user.id],
    );
    if (!lock.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Growth Application not found.' });
    }
    const application = lock.rows[0];
    if (application.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only a draft Growth Application can be submitted.' });
    }
    if (!application.popia_consent) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'POPIA consent is required before submission.' });
    }
    const required = await client.query(
      `SELECT field_key, label FROM growth_form_fields
        WHERE version_id = $1 AND is_enabled = true AND is_required = true
          AND (sensitive = false OR sensitive_enabled = true)
          AND applicant_types ? $2`,
      [application.form_version_id, application.applicant_type],
    );
    const current = await latestAnswers(id, client);
    const missing = required.rows.filter((row) => !current[row.field_key] || isEmptyValue(current[row.field_key].value));
    if (missing.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Complete all required fields before submitting.', missingFields: missing });
    }
    await client.query(
      `UPDATE growth_applications
          SET status = 'submitted', submitted_at = now(), locked_at = now(),
              current_stage = 'submitted', completion_percent = 100,
              last_saved_at = now(), updated_at = now()
        WHERE id = $1`,
      [id],
    );
    await client.query(
      `INSERT INTO growth_status_history(application_id, from_status, to_status, changed_by, note)
       VALUES ($1,'draft','submitted',$2,'Member submitted application')`,
      [id, req.user.id],
    );
    await client.query('COMMIT');
    return res.json({ application: { id, status: 'submitted', completionPercent: 100 } });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.post('/applications/:id/withdraw', async (req, res, next) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid application id.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT status FROM growth_applications WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, req.user.id],
    );
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Growth Application not found.' });
    }
    if (['withdrawn','completed','closed'].includes(current.rows[0].status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This Growth Application cannot be withdrawn.' });
    }
    await client.query(
      `UPDATE growth_applications
          SET status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = $3,
              locked_at = COALESCE(locked_at, now()), updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [id, req.user.id, String(req.body?.reason || '').trim() || null],
    );
    await client.query(
      `INSERT INTO growth_status_history(application_id, from_status, to_status, changed_by, note)
       VALUES ($1,$2,'withdrawn',$3,'Member withdrew application')`,
      [id, current.rows[0].status, req.user.id],
    );
    await client.query('COMMIT');
    return res.json({ application: { id, status: 'withdrawn' } });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.post('/information-requests/:requestId/respond', async (req, res, next) => {
  const requestId = intId(req.params.requestId);
  if (!requestId) return res.status(400).json({ error: 'Invalid request id.' });
  const responseText = String(req.body?.responseText || '').trim();
  const responseData = req.body?.responseData && typeof req.body.responseData === 'object' ? req.body.responseData : {};
  if (!responseText && !Object.keys(responseData).length) {
    return res.status(400).json({ error: 'Provide a response.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const request = await client.query(
      `SELECT r.id, r.application_id, r.status
         FROM growth_information_requests r
         JOIN growth_applications a ON a.id = r.application_id
        WHERE r.id = $1 AND a.user_id = $2
        FOR UPDATE OF r`,
      [requestId, req.user.id],
    );
    if (!request.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Information request not found.' });
    }
    if (request.rows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This information request is no longer open.' });
    }
    await client.query(
      `INSERT INTO growth_information_responses
         (request_id, application_id, response_text, response_data, responded_by)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [requestId, request.rows[0].application_id, responseText || null, JSON.stringify(responseData), req.user.id],
    );
    await client.query(`UPDATE growth_information_requests SET status='responded', responded_at=now() WHERE id=$1`, [requestId]);
    await client.query(
      `UPDATE growth_applications SET status='under_review', updated_at=now()
        WHERE id=$1 AND status='information_requested'`,
      [request.rows[0].application_id],
    );
    await client.query('COMMIT');
    return res.status(201).json({ responded: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.get('/statuses', (req, res) => res.json({ statuses: Array.from(MEMBER_STATUSES) }));

module.exports = router;
