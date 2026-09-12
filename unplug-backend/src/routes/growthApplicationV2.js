'use strict';

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.user.role !== 'member') {
    return res.status(403).json({ error: 'Growth Applications are available to member accounts only.' });
  }
  return next();
});

const asId = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

function empty(value) {
  return value == null
    || (typeof value === 'string' && !value.trim())
    || (Array.isArray(value) && !value.length)
    || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
}

function rawAnswer(answerMap, fieldKey) {
  return answerMap && answerMap[fieldKey] ? answerMap[fieldKey].value : undefined;
}

function conditionMatches(condition, answerMap) {
  if (!condition || !condition.field) return true;
  const actual = rawAnswer(answerMap, condition.field);
  const expected = condition.value;
  switch (condition.operator || 'equals') {
    case 'equals': return actual === expected;
    case 'not_equals': return actual !== expected;
    case 'includes': return Array.isArray(actual) ? actual.includes(expected) : String(actual || '').includes(String(expected || ''));
    case 'truthy': return actual === true || actual === 'yes' || Boolean(actual);
    case 'not_empty': return !empty(actual);
    default: return false;
  }
}

function visibleByRules(rules, answerMap) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || !Object.keys(rules).length) return true;
  const all = Array.isArray(rules.all) ? rules.all : [];
  const any = Array.isArray(rules.any) ? rules.any : [];
  if (all.length && !all.every((condition) => conditionMatches(condition, answerMap))) return false;
  if (any.length && !any.some((condition) => conditionMatches(condition, answerMap))) return false;
  return true;
}

function fieldComplete(field, answerMap) {
  const value = rawAnswer(answerMap, field.field_key);
  if (['checkbox', 'consent', 'declaration'].includes(field.field_type)) return value === true;
  return !empty(value);
}

async function owned(applicationId, userId, client = pool) {
  const result = await client.query(
    `SELECT id,user_id,applicant_email,applicant_type,status,form_version_id,completion_percent,last_saved_at,
            popia_consent,popia_consent_at,popia_consent_version,submitted_at,locked_at,withdrawn_at,
            external_sharing_allowed,external_sharing_consent_at,created_at,updated_at
       FROM growth_applications WHERE id=$1 AND user_id=$2`,
    [applicationId, userId],
  );
  return result.rows[0] || null;
}

async function form(versionId, applicantType, client = pool) {
  const version = await client.query(
    `SELECT v.id,v.version_number,v.title,v.intro_text,v.consent_text,
            f.id AS form_id,f.slug,f.name
       FROM growth_form_versions v
       JOIN growth_forms f ON f.id=v.form_id
      WHERE v.id=$1`,
    [versionId],
  );
  if (!version.rowCount) return null;

  const steps = await client.query(
    `SELECT id,step_key,title,description,display_order
       FROM growth_form_steps
      WHERE version_id=$1 AND is_enabled=true
      ORDER BY display_order,id`,
    [versionId],
  );

  const fields = await client.query(
    `SELECT f.id,f.step_id,f.field_key,f.label,f.help_text,f.placeholder,f.field_type,
            f.display_order,f.is_required,f.sensitive,f.confidential,f.allow_external_sharing,
            f.validation_rules,f.visibility_rules,f.audience,
            COALESCE(jsonb_agg(jsonb_build_object(
              'value',o.option_value,'label',o.option_label,'displayOrder',o.display_order
            ) ORDER BY o.display_order,o.id) FILTER (WHERE o.id IS NOT NULL),'[]'::jsonb) AS options
       FROM growth_form_fields f
       LEFT JOIN growth_form_field_options o ON o.field_id=f.id AND o.is_enabled=true
      WHERE f.version_id=$1
        AND f.is_enabled=true
        AND (f.sensitive=false OR f.sensitive_enabled=true)
        AND f.applicant_types ? $2
        AND f.audience IN ('applicant','both')
        AND f.field_type <> 'admin_only'
      GROUP BY f.id
      ORDER BY f.step_id,f.display_order,f.id`,
    [versionId, applicantType],
  );

  return { ...version.rows[0], steps: steps.rows, fields: fields.rows };
}

async function activeForm(applicantType, client = pool) {
  const version = await client.query(
    `SELECT v.id
       FROM growth_forms f
       JOIN growth_form_versions v ON v.form_id=f.id
      WHERE f.is_master=true AND f.is_active=true AND v.status='published'
      ORDER BY v.version_number DESC
      LIMIT 1`,
  );
  return version.rowCount ? form(version.rows[0].id, applicantType, client) : null;
}

async function answers(applicationId, client = pool, onlyKeys = null) {
  const params = [applicationId];
  let extra = '';
  if (onlyKeys && onlyKeys.length) {
    params.push(onlyKeys);
    extra = 'AND field_key=ANY($2::text[])';
  }
  const result = await client.query(
    `SELECT DISTINCT ON(field_key)
            field_key,field_id,value_json,revision_number,created_at
       FROM growth_application_answer_revisions
      WHERE application_id=$1 ${extra}
      ORDER BY field_key,revision_number DESC`,
    params,
  );
  return Object.fromEntries(result.rows.map((row) => [row.field_key, {
    value: row.value_json,
    revision: row.revision_number,
    savedAt: row.created_at,
  }]));
}

async function requiredFields(versionId, applicantType, answerMap, client = pool) {
  const result = await client.query(
    `SELECT field_key,label,field_type,visibility_rules
       FROM growth_form_fields
      WHERE version_id=$1
        AND is_enabled=true
        AND is_required=true
        AND (sensitive=false OR sensitive_enabled=true)
        AND applicant_types ? $2
        AND audience IN ('applicant','both')
        AND field_type NOT IN ('heading','info','admin_only')
      ORDER BY display_order,id`,
    [versionId, applicantType],
  );
  return result.rows.filter((field) => visibleByRules(field.visibility_rules, answerMap));
}

async function updateCompletion(application, client = pool) {
  const current = await answers(application.id, client);
  const required = await requiredFields(application.form_version_id, application.applicant_type, current, client);
  const completed = required.filter((field) => fieldComplete(field, current)).length;
  const percent = required.length ? Math.round((completed / required.length) * 100) : 100;
  await client.query(
    `UPDATE growth_applications
        SET completion_percent=$2,last_saved_at=now(),updated_at=now()
      WHERE id=$1`,
    [application.id, percent],
  );
  return percent;
}

async function infoRequests(applicationId, client = pool) {
  const result = await client.query(
    `SELECT q.id,q.request_text,q.requested_fields,q.status,q.requested_at,q.responded_at,q.closed_at,
            COALESCE(jsonb_agg(jsonb_build_object(
              'id',x.id,'responseText',x.response_text,'responseData',x.response_data,'createdAt',x.created_at
            ) ORDER BY x.created_at) FILTER(WHERE x.id IS NOT NULL),'[]'::jsonb) AS responses
       FROM growth_information_requests q
       LEFT JOIN growth_information_responses x ON x.request_id=q.id
      WHERE q.application_id=$1
      GROUP BY q.id
      ORDER BY q.requested_at DESC`,
    [applicationId],
  );
  return result.rows;
}

async function prefillFromMember(application, userId, client) {
  const profile = await client.query(
    `SELECT u.email,u.phone,p.display_name,p.about_me,p.country,p.province,p.city,
            COALESCE((SELECT jsonb_agg(s.key ORDER BY s.key) FROM mu_profile_skills s WHERE s.user_id=u.id),'[]'::jsonb) AS skills,
            COALESCE((SELECT jsonb_agg(i.key ORDER BY i.key) FROM mu_profile_interests i WHERE i.user_id=u.id),'[]'::jsonb) AS interests
       FROM users u
       LEFT JOIN my_unplug_profiles p ON p.user_id=u.id
      WHERE u.id=$1`,
    [userId],
  );
  if (!profile.rowCount) return;

  const row = profile.rows[0];
  const candidates = {
    growth_display_name: row.display_name,
    growth_email: row.email,
    growth_phone: row.phone,
    growth_country: row.country,
    growth_province: row.province,
    growth_city: row.city,
    growth_bio: row.about_me,
    growth_skills: row.skills,
    growth_interests: row.interests,
  };
  const keys = Object.entries(candidates)
    .filter(([, value]) => !empty(value))
    .map(([key]) => key);
  if (!keys.length) return;

  const fields = await client.query(
    `SELECT id,field_key
       FROM growth_form_fields
      WHERE version_id=$1
        AND field_key=ANY($2::text[])
        AND is_enabled=true
        AND applicant_types ? $3
        AND audience IN ('applicant','both')`,
    [application.form_version_id, keys, application.applicant_type],
  );

  for (const field of fields.rows) {
    await client.query(
      `INSERT INTO growth_application_answer_revisions
         (application_id,field_id,field_key,revision_number,value_json,saved_by,save_source)
       VALUES($1,$2,$3,1,$4::jsonb,$5,'prefill')`,
      [application.id, field.id, field.field_key, JSON.stringify(candidates[field.field_key]), userId],
    );
  }
}

router.get('/form', async (req, res, next) => {
  const type = req.query.applicantType === 'business' ? 'business' : 'individual';
  try {
    const active = await activeForm(type);
    return active
      ? res.json({ form: active })
      : res.status(409).json({ error: 'The Growth Application is not currently open for new applications.' });
  } catch (err) { return next(err); }
});

router.get('/applications', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id,applicant_type,status,completion_percent,last_saved_at,submitted_at,
              withdrawn_at,created_at,updated_at
         FROM growth_applications
        WHERE user_id=$1
        ORDER BY created_at DESC`,
      [req.user.id],
    );
    return res.json({ applications: result.rows });
  } catch (err) { return next(err); }
});

router.post('/applications', async (req, res, next) => {
  const type = req.body?.applicantType;
  if (!['individual','business'].includes(type)) {
    return res.status(400).json({ error: 'Choose individual or business.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const active = await activeForm(type, client);
    if (!active) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The Growth Application is not currently open for new applications.' });
    }
    const result = await client.query(
      `INSERT INTO growth_applications
         (user_id,applicant_email,applicant_type,status,form_version_id,current_stage,
          question_bank_version,last_saved_at)
       VALUES($1,$2,$3,'draft',$4,'quick_profile',$5,now())
       RETURNING id,user_id,applicant_type,status,form_version_id,completion_percent,
                 last_saved_at,created_at,updated_at`,
      [req.user.id, req.user.email, type, active.id, `growth-v2-${active.version_number}`],
    );
    const application = result.rows[0];
    await prefillFromMember(application, req.user.id, client);
    application.completion_percent = await updateCompletion(application, client);
    await client.query(
      `INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,note)
       VALUES($1,NULL,'draft',$2,'Application created')`,
      [application.id, req.user.id],
    );
    await client.query('COMMIT');
    return res.status(201).json({ application, form: active, answers: await answers(application.id) });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.get('/applications/:id', async (req, res, next) => {
  const applicationId = asId(req.params.id);
  if (!applicationId) return res.status(400).json({ error: 'Invalid application id.' });
  try {
    const application = await owned(applicationId, req.user.id);
    if (!application) return res.status(404).json({ error: 'Growth Application not found.' });
    const requests = await infoRequests(applicationId);

    if (application.status !== 'draft') {
      const reopened = await pool.query(
        `SELECT field_key,reason,opened_at
           FROM growth_application_field_reopens
          WHERE application_id=$1 AND closed_at IS NULL
          ORDER BY opened_at`,
        [applicationId],
      );
      const payload = { application, informationRequests: requests, reopenedFields: reopened.rows };
      if (reopened.rowCount) {
        const full = await form(application.form_version_id, application.applicant_type);
        const keys = reopened.rows.map((row) => row.field_key);
        payload.reopenedForm = {
          ...full,
          fields: full.fields.filter((field) => keys.includes(field.field_key)),
          steps: full.steps.filter((step) => full.fields.some((field) => keys.includes(field.field_key) && field.step_id === step.id)),
        };
        payload.reopenedAnswers = await answers(applicationId, pool, keys);
      }
      return res.json(payload);
    }

    return res.json({
      application,
      form: await form(application.form_version_id, application.applicant_type),
      answers: await answers(applicationId),
      informationRequests: requests,
    });
  } catch (err) { return next(err); }
});

router.patch('/applications/:id/consent', async (req, res, next) => {
  const applicationId = asId(req.params.id);
  if (!applicationId || typeof req.body?.accepted !== 'boolean') {
    return res.status(400).json({ error: 'Provide accepted=true or false.' });
  }
  try {
    const result = await pool.query(
      `UPDATE growth_applications
          SET popia_consent=$3,
              popia_consent_at=CASE WHEN $3 THEN now() ELSE NULL END,
              popia_consent_version=CASE WHEN $3 THEN COALESCE($4,popia_consent_version,'growth-v2') ELSE NULL END,
              updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status='draft'
        RETURNING id,popia_consent,popia_consent_at,popia_consent_version`,
      [applicationId, req.user.id, req.body.accepted, String(req.body?.version || '').trim() || null],
    );
    return result.rowCount
      ? res.json(result.rows[0])
      : res.status(409).json({ error: 'Consent can only be changed while the application is a draft.' });
  } catch (err) { return next(err); }
});

router.patch('/applications/:id/external-sharing', async (req, res, next) => {
  const applicationId = asId(req.params.id);
  if (!applicationId || typeof req.body?.allowed !== 'boolean') {
    return res.status(400).json({ error: 'Provide allowed=true or false.' });
  }
  try {
    const result = await pool.query(
      `UPDATE growth_applications
          SET external_sharing_allowed=$3,
              external_sharing_consent_at=CASE WHEN $3 THEN now() ELSE NULL END,
              updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status='draft'
        RETURNING id,external_sharing_allowed,external_sharing_consent_at`,
      [applicationId, req.user.id, req.body.allowed],
    );
    return result.rowCount
      ? res.json(result.rows[0])
      : res.status(409).json({ error: 'External-sharing consent can only be changed while the application is a draft.' });
  } catch (err) { return next(err); }
});

router.put('/applications/:id/answers', async (req, res, next) => {
  const applicationId = asId(req.params.id);
  const input = req.body?.answers;
  if (!applicationId || !input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({ error: 'Provide answers keyed by field key.' });
  }
  const keys = Object.keys(input);
  if (!keys.length) return res.status(400).json({ error: 'No answers supplied.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT * FROM growth_applications WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [applicationId, req.user.id],
    );
    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Growth Application not found.' });
    }
    const application = locked.rows[0];
    if (['withdrawn','completed','closed'].includes(application.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This Growth Application can no longer be edited.' });
    }

    const valid = await client.query(
      `SELECT id,field_key
         FROM growth_form_fields
        WHERE version_id=$1
          AND is_enabled=true
          AND (sensitive=false OR sensitive_enabled=true)
          AND applicant_types ? $2
          AND audience IN ('applicant','both')
          AND field_type NOT IN ('heading','info','admin_only')
          AND field_key=ANY($3::text[])`,
      [application.form_version_id, application.applicant_type, keys],
    );
    const fieldMap = new Map(valid.rows.map((field) => [field.field_key, field.id]));
    if (fieldMap.size !== keys.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'One or more fields are invalid for this application.' });
    }

    if (application.status !== 'draft') {
      const reopened = await client.query(
        `SELECT field_key
           FROM growth_application_field_reopens
          WHERE application_id=$1 AND closed_at IS NULL AND field_key=ANY($2::text[])`,
        [applicationId, keys],
      );
      if (reopened.rowCount !== keys.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Only fields specifically reopened by Unplug can be edited after submission.' });
      }
    }

    for (const key of keys) {
      const revision = await client.query(
        `SELECT COALESCE(MAX(revision_number),0)+1 AS n
           FROM growth_application_answer_revisions
          WHERE application_id=$1 AND field_key=$2`,
        [applicationId, key],
      );
      await client.query(
        `INSERT INTO growth_application_answer_revisions
           (application_id,field_id,field_key,revision_number,value_json,saved_by,save_source)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [applicationId, fieldMap.get(key), key, revision.rows[0].n,
          JSON.stringify(input[key] ?? null), req.user.id,
          application.status === 'draft' ? 'member' : 'admin_reopen'],
      );
    }

    if (application.status !== 'draft') {
      await client.query(
        `UPDATE growth_application_field_reopens
            SET closed_at=now()
          WHERE application_id=$1 AND closed_at IS NULL AND field_key=ANY($2::text[])`,
        [applicationId, keys],
      );
    }

    const percent = await updateCompletion(application, client);
    await client.query('COMMIT');
    return res.json({ saved: keys, completionPercent: percent });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.post('/applications/:id/submit', async (req, res, next) => {
  const applicationId = asId(req.params.id);
  if (!applicationId) return res.status(400).json({ error: 'Invalid application id.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT * FROM growth_applications WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [applicationId, req.user.id],
    );
    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Growth Application not found.' });
    }
    const application = locked.rows[0];
    if (application.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only a draft can be submitted.' });
    }
    if (!application.popia_consent) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'POPIA consent is required before submission.' });
    }

    const current = await answers(applicationId, client);
    const required = await requiredFields(application.form_version_id, application.applicant_type, current, client);
    const missing = required.filter((field) => !fieldComplete(field, current));
    if (missing.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Complete all required visible fields before submitting.',
        missingFields: missing.map((field) => ({ field_key: field.field_key, label: field.label })),
      });
    }

    await client.query(
      `UPDATE growth_applications
          SET status='submitted',submitted_at=now(),locked_at=now(),current_stage='submitted',
              completion_percent=100,last_saved_at=now(),updated_at=now()
        WHERE id=$1`,
      [applicationId],
    );
    await client.query(
      `INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,note)
       VALUES($1,'draft','submitted',$2,'Member submitted application')`,
      [applicationId, req.user.id],
    );
    await client.query('COMMIT');
    return res.json({ application: { id: applicationId, status: 'submitted', completionPercent: 100 } });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.post('/applications/:id/withdraw', async (req, res, next) => {
  const applicationId = asId(req.params.id);
  if (!applicationId) return res.status(400).json({ error: 'Invalid application id.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT status FROM growth_applications WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [applicationId, req.user.id],
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
          SET status='withdrawn',withdrawn_at=now(),withdrawn_reason=$3,
              locked_at=COALESCE(locked_at,now()),updated_at=now()
        WHERE id=$1 AND user_id=$2`,
      [applicationId, req.user.id, String(req.body?.reason || '').trim() || null],
    );
    await client.query(
      `INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,note)
       VALUES($1,$2,'withdrawn',$3,'Member withdrew application')`,
      [applicationId, current.rows[0].status, req.user.id],
    );
    await client.query('COMMIT');
    return res.json({ application: { id: applicationId, status: 'withdrawn' } });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

router.post('/information-requests/:id/respond', async (req, res, next) => {
  const requestId = asId(req.params.id);
  const responseText = String(req.body?.responseText || '').trim();
  const responseData = req.body?.responseData && typeof req.body.responseData === 'object' && !Array.isArray(req.body.responseData)
    ? req.body.responseData : {};
  if (!requestId || (!responseText && !Object.keys(responseData).length)) {
    return res.status(400).json({ error: 'Provide a response.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const request = await client.query(
      `SELECT q.id,q.application_id,q.status,a.status AS application_status
         FROM growth_information_requests q
         JOIN growth_applications a ON a.id=q.application_id
        WHERE q.id=$1 AND a.user_id=$2
        FOR UPDATE OF q,a`,
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
         (request_id,application_id,response_text,response_data,responded_by)
       VALUES($1,$2,$3,$4::jsonb,$5)`,
      [requestId, request.rows[0].application_id, responseText || null,
        JSON.stringify(responseData), req.user.id],
    );
    await client.query(
      `UPDATE growth_information_requests SET status='responded',responded_at=now() WHERE id=$1`,
      [requestId],
    );
    if (request.rows[0].application_status === 'information_requested') {
      await client.query(
        `UPDATE growth_applications SET status='under_review',updated_at=now() WHERE id=$1`,
        [request.rows[0].application_id],
      );
      await client.query(
        `INSERT INTO growth_status_history(application_id,from_status,to_status,changed_by,note)
         VALUES($1,'information_requested','under_review',$2,'Member responded to information request')`,
        [request.rows[0].application_id, req.user.id],
      );
    }
    await client.query('COMMIT');
    return res.status(201).json({ responded: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally { client.release(); }
});

module.exports = router;
