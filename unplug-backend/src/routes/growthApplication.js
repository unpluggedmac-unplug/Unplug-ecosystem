'use strict';

const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { QUESTION_BANK_VERSION, bank } = require('../data/growthApplicationQuestions');

const router = express.Router();
const shortLinkRouter = express.Router();

const STATUS_VALUES = new Set(['new', 'under_review', 'contacted', 'in_progress', 'closed']);
const MESSAGE_STATUSES = new Set(['contacted', 'in_progress', 'closed']);
const APPLICANT_TYPES = new Set(['individual', 'business']);
const STAGES = new Set(['quick_profile', 'growth_assessment', 'deep_discovery']);
const PLACEMENT_KEYS = new Set([
  'homepage', 'latest_news', 'directory', 'gallery', 'editions', 'top10', 'competitions', 'member_dashboard',
]);

const NON_BINARY_PROMPTS = new Set([
  'Are you studying, employed, self-employed, freelancing, looking for work, or exploring opportunities?',
  'Are your customers individuals, businesses, government, or organisations?',
  'Is revenue increasing, stable, or declining?',
]);

function isYesNoPrompt(text) {
  if (NON_BINARY_PROMPTS.has(text)) return false;
  return /^(Do|Does|Did|Have|Has|Can|Are|Is|Would|Could|Will)\b/i.test(text);
}

function publicQuestionBank(type) {
  const groups = bank[type].map((group) => ({
    ...group,
    questions: group.questions.map((question) => ({
      ...question,
      ...(isYesNoPrompt(question.text)
        ? { type: 'yes_no_with_context', context_required: true, context_label: 'Tell us more' }
        : {}),
    })),
  }));
  return {
    version: bank.version,
    applicant_type: type,
    groups,
    closing: bank.closing,
    rules: {
      all_questions_required: true,
      unavailable_answers_count_as_complete: true,
      yes_no_context_required: true,
    },
  };
}

function flattenQuestions(type) {
  return [...publicQuestionBank(type).groups.flatMap((g) => g.questions), ...bank.closing];
}

function isUnavailable(value) {
  return Boolean(value && typeof value === 'object' && value.unavailable === true);
}

function isAnswered(question, value) {
  if (isUnavailable(value)) return true;
  if (question.type === 'checklist') {
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value && typeof value === 'object' && Array.isArray(value.selected) && value.selected.length > 0);
  }
  if (question.type === 'yes_no_with_context') {
    if (!value || typeof value !== 'object') return false;
    const answer = String(value.answer || '').trim().toLowerCase();
    const context = String(value.context || '').trim();
    return ['yes', 'no'].includes(answer) && context.length > 0;
  }
  if (typeof value === 'string') return value.trim().length > 0;
  if (value && typeof value === 'object') return String(value.answer || '').trim().length > 0;
  return false;
}

function validateDeepDiscovery(type, payload) {
  const questions = flattenQuestions(type);
  const missing = questions.filter((q) => !isAnswered(q, payload ? payload[q.id] : undefined));
  return { ok: missing.length === 0, total: questions.length, missing: missing.map((q) => ({ id: q.id, text: q.text })) };
}

function safeApplication(row, includePrivate = false) {
  if (!row) return row;
  const copy = { ...row };
  delete copy.resume_token_hash;
  if (!includePrivate) {
    delete copy.admin_notes;
    delete copy.research_notes;
    delete copy.closed_reason;
  }
  return copy;
}

function siteUrl() {
  return String(process.env.SITE_URL || 'https://www.unplugnews.com').replace(/\/$/, '');
}

function newResumeToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

function newShortCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase();
}

async function getOwnedApplication(id, userId) {
  const result = await pool.query('SELECT * FROM growth_applications WHERE id = $1 AND user_id = $2', [id, userId]);
  return result.rows[0] || null;
}

async function sendGrowthEmail(to, subject, text) {
  try {
    await sendEmail({ to, subject, text });
  } catch (err) {
    console.error('[growth-application] email failed:', err.message);
  }
}

// ----- Member/applicant API -----

router.get('/questions', requireAuth, (req, res) => {
  const type = String(req.query.type || '').toLowerCase();
  if (!APPLICANT_TYPES.has(type)) return res.status(400).json({ error: 'type must be individual or business.' });
  return res.json(publicQuestionBank(type));
});

router.get('/config', requireAuth, async (req, res, next) => {
  try {
    const [settings, placements] = await Promise.all([
      pool.query("SELECT key, value FROM settings WHERE key IN ('growth_application_site_visibility','growth_application_response_days','growth_application_short_code')"),
      pool.query('SELECT page_key, enabled FROM growth_application_placements ORDER BY page_key'),
    ]);
    const values = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]));
    return res.json({
      site_visibility: values.growth_application_site_visibility || 'hidden',
      response_days: Number(values.growth_application_response_days || 5),
      placements: placements.rows,
      question_bank_version: QUESTION_BANK_VERSION,
    });
  } catch (err) { next(err); }
});

router.post('/applications', requireAuth, async (req, res, next) => {
  try {
    const type = String(req.body.applicant_type || '').toLowerCase();
    if (!APPLICANT_TYPES.has(type)) return res.status(400).json({ error: 'applicant_type must be individual or business.' });

    const user = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.user.id]);
    if (!user.rowCount) return res.status(401).json({ error: 'Member account not found.' });

    const { token, hash } = newResumeToken();
    const result = await pool.query(
      `INSERT INTO growth_applications
        (user_id, applicant_email, applicant_type, resume_token_hash, resume_token_created_at, question_bank_version)
       VALUES ($1,$2,$3,$4,now(),$5)
       RETURNING *`,
      [req.user.id, user.rows[0].email, type, hash, QUESTION_BANK_VERSION],
    );
    const application = safeApplication(result.rows[0]);
    const resume_url = `${siteUrl()}/unplug-growth-application.html?resume=${encodeURIComponent(token)}`;

    sendGrowthEmail(
      application.applicant_email,
      'Your Unplug Growth Application is ready',
      `Your Growth Application has been started. You can resume it here: ${resume_url}`,
    );

    return res.status(201).json({ application, resume_url, resume_token: token });
  } catch (err) { next(err); }
});

router.get('/applications/me', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, applicant_type, current_stage, stage_progress, status, submitted_at, closed_at, created_at, updated_at, question_bank_version
       FROM growth_applications WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id],
    );
    return res.json({ applications: result.rows });
  } catch (err) { next(err); }
});

router.get('/applications/:id', requireAuth, async (req, res, next) => {
  try {
    const application = await getOwnedApplication(req.params.id, req.user.id);
    if (!application) return res.status(404).json({ error: 'Growth Application not found.' });
    const [tasks, messages] = await Promise.all([
      pool.query('SELECT id,title,due_date,status,completed_at,created_at,updated_at FROM growth_application_tasks WHERE application_id=$1 ORDER BY created_at', [application.id]),
      pool.query('SELECT id,transition_status,message,created_at FROM growth_application_messages WHERE application_id=$1 ORDER BY created_at', [application.id]),
    ]);
    return res.json({ application: safeApplication(application), tasks: tasks.rows, messages: messages.rows });
  } catch (err) { next(err); }
});

router.patch('/applications/:id/autosave', requireAuth, async (req, res, next) => {
  try {
    const application = await getOwnedApplication(req.params.id, req.user.id);
    if (!application) return res.status(404).json({ error: 'Growth Application not found.' });
    if (application.submitted_at) return res.status(409).json({ error: 'Submitted applications are read-only.' });

    const stage = String(req.body.stage || '');
    if (!STAGES.has(stage)) return res.status(400).json({ error: 'Invalid stage.' });
    const payload = req.body.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return res.status(400).json({ error: 'data must be an object.' });

    const column = stage === 'deep_discovery'
      ? (application.applicant_type === 'individual' ? 'deep_discovery_individual' : 'deep_discovery_business')
      : stage;

    const progress = req.body.stage_progress && typeof req.body.stage_progress === 'object'
      ? req.body.stage_progress
      : application.stage_progress;

    const result = await pool.query(
      `UPDATE growth_applications
       SET ${column}=$1::jsonb, stage_progress=$2::jsonb, current_stage=$3
       WHERE id=$4 AND user_id=$5 RETURNING *`,
      [JSON.stringify(payload), JSON.stringify(progress), stage, application.id, req.user.id],
    );
    return res.json({ application: safeApplication(result.rows[0]) });
  } catch (err) { next(err); }
});

router.patch('/applications/:id/images', requireAuth, async (req, res, next) => {
  try {
    const application = await getOwnedApplication(req.params.id, req.user.id);
    if (!application) return res.status(404).json({ error: 'Growth Application not found.' });
    if (application.submitted_at) return res.status(409).json({ error: 'Submitted applications are read-only.' });
    const gallery = String(req.body.gallery || '');
    if (!['brand_style_images', 'applicant_team_images'].includes(gallery)) return res.status(400).json({ error: 'Invalid gallery.' });
    const images = req.body.images;
    if (!Array.isArray(images) || images.length > 10) return res.status(400).json({ error: 'A gallery can contain at most 10 images.' });
    for (const image of images) {
      if (!image || typeof image !== 'object' || !String(image.url || '').trim()) return res.status(400).json({ error: 'Each gallery image must include a URL.' });
      if (image.bytes != null && Number(image.bytes) > 10 * 1024 * 1024) return res.status(400).json({ error: 'Each image must be 10 MB or smaller.' });
    }
    const result = await pool.query(`UPDATE growth_applications SET ${gallery}=$1::jsonb WHERE id=$2 AND user_id=$3 RETURNING *`, [JSON.stringify(images), application.id, req.user.id]);
    return res.json({ application: safeApplication(result.rows[0]) });
  } catch (err) { next(err); }
});

router.post('/applications/:id/resume-link', requireAuth, async (req, res, next) => {
  try {
    const application = await getOwnedApplication(req.params.id, req.user.id);
    if (!application) return res.status(404).json({ error: 'Growth Application not found.' });
    const { token, hash } = newResumeToken();
    await pool.query('UPDATE growth_applications SET resume_token_hash=$1,resume_token_created_at=now() WHERE id=$2', [hash, application.id]);
    const resume_url = `${siteUrl()}/unplug-growth-application.html?resume=${encodeURIComponent(token)}`;
    sendGrowthEmail(application.applicant_email, 'Your Unplug Growth Application resume link', `Resume your Growth Application here: ${resume_url}`);
    return res.json({ resume_url, resume_token: token });
  } catch (err) { next(err); }
});

router.get('/resume/:token', requireAuth, async (req, res, next) => {
  try {
    const hash = crypto.createHash('sha256').update(String(req.params.token || '')).digest('hex');
    const result = await pool.query('SELECT * FROM growth_applications WHERE resume_token_hash=$1 AND user_id=$2', [hash, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Resume link is invalid for this member.' });
    return res.json({ application: safeApplication(result.rows[0]) });
  } catch (err) { next(err); }
});

router.post('/applications/:id/submit', requireAuth, async (req, res, next) => {
  try {
    const application = await getOwnedApplication(req.params.id, req.user.id);
    if (!application) return res.status(404).json({ error: 'Growth Application not found.' });
    if (application.submitted_at) return res.status(409).json({ error: 'This Growth Application has already been submitted.' });
    if (application.question_bank_version !== QUESTION_BANK_VERSION) {
      return res.status(409).json({ error: 'This draft uses an outdated question bank. Refresh the application before submitting.' });
    }

    const deep = application.applicant_type === 'individual' ? application.deep_discovery_individual : application.deep_discovery_business;
    const validation = validateDeepDiscovery(application.applicant_type, deep);
    if (!validation.ok) return res.status(422).json({ error: 'Deep Discovery is incomplete.', total_questions: validation.total, missing: validation.missing });
    if (!application.quick_profile || Object.keys(application.quick_profile).length === 0) return res.status(422).json({ error: 'Quick Profile is incomplete.' });
    if (!application.growth_assessment || Object.keys(application.growth_assessment).length === 0) return res.status(422).json({ error: 'Growth Assessment is incomplete.' });

    const consent = req.body.popia_consent === true;
    if (!consent) return res.status(422).json({ error: 'POPIA/privacy consent is required before submission.' });

    const result = await pool.query(
      `UPDATE growth_applications
       SET popia_consent=TRUE, popia_consent_at=now(), popia_consent_version=$1,
           current_stage='submitted', submitted_at=now(), status='new'
       WHERE id=$2 AND user_id=$3 RETURNING *`,
      [String(req.body.popia_consent_version || 'growth-application-v1'), application.id, req.user.id],
    );
    const settings = await pool.query("SELECT value FROM settings WHERE key='growth_application_response_days'");
    const responseDays = Number(settings.rows[0]?.value || 5);
    sendGrowthEmail(
      result.rows[0].applicant_email,
      'We received your Unplug Growth Application',
      `Thanks — a real person reads every application. We'll be in touch within ${responseDays} business days.`,
    );
    return res.json({
      application: safeApplication(result.rows[0]),
      confirmation: `Thanks — a real person reads every application. We'll be in touch within ${responseDays} business days.`,
    });
  } catch (err) { next(err); }
});

// ----- Admin API -----

router.get('/admin/applications', requireRole('admin'), async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !STATUS_VALUES.has(status)) return res.status(400).json({ error: 'Invalid status.' });
    const result = await pool.query(
      `SELECT ga.id, ga.applicant_type, ga.applicant_email, ga.current_stage, ga.stage_progress,
              ga.status, ga.submitted_at, ga.closed_at, ga.created_at, ga.updated_at,
              u.email AS member_email
       FROM growth_applications ga LEFT JOIN users u ON u.id=ga.user_id
       WHERE ($1::text IS NULL OR ga.status=$1)
       ORDER BY COALESCE(ga.submitted_at,ga.created_at) DESC`,
      [status],
    );
    return res.json({ applications: result.rows });
  } catch (err) { next(err); }
});

router.get('/admin/applications/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM growth_applications WHERE id=$1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Growth Application not found.' });
    const [tasks, messages] = await Promise.all([
      pool.query('SELECT * FROM growth_application_tasks WHERE application_id=$1 ORDER BY created_at', [req.params.id]),
      pool.query('SELECT * FROM growth_application_messages WHERE application_id=$1 ORDER BY created_at', [req.params.id]),
    ]);
    return res.json({ application: safeApplication(result.rows[0], true), tasks: tasks.rows, messages: messages.rows });
  } catch (err) { next(err); }
});

router.patch('/admin/applications/:id/notes', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'UPDATE growth_applications SET admin_notes=$1,research_notes=$2 WHERE id=$3 RETURNING *',
      [req.body.admin_notes ?? null, req.body.research_notes ?? null, req.params.id],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Growth Application not found.' });
    return res.json({ application: safeApplication(result.rows[0], true) });
  } catch (err) { next(err); }
});

router.patch('/admin/applications/:id/status', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const status = String(req.body.status || '');
    if (!STATUS_VALUES.has(status)) return res.status(400).json({ error: 'Invalid status.' });
    const message = String(req.body.message || '').trim();
    const closedReason = String(req.body.closed_reason || '').trim();
    if (MESSAGE_STATUSES.has(status) && !message) return res.status(422).json({ error: `An applicant-facing message is required when moving to ${status}.` });
    if (status === 'closed' && !closedReason) return res.status(422).json({ error: 'A private closed_reason is required when closing an application.' });

    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM growth_applications WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Growth Application not found.' });
    }
    const updated = await client.query(
      `UPDATE growth_applications SET status=$1, closed_reason=CASE WHEN $1='closed' THEN $2 ELSE closed_reason END,
         closed_at=CASE WHEN $1='closed' THEN now() ELSE closed_at END WHERE id=$3 RETURNING *`,
      [status, closedReason || null, req.params.id],
    );
    if (MESSAGE_STATUSES.has(status)) {
      await client.query(
        'INSERT INTO growth_application_messages(application_id,transition_status,message,sent_by) VALUES ($1,$2,$3,$4)',
        [req.params.id, status, message, req.user.id],
      );
    }
    await client.query('COMMIT');

    if (MESSAGE_STATUSES.has(status)) {
      sendGrowthEmail(updated.rows[0].applicant_email, `Your Unplug Growth Application — ${status.replace('_', ' ')}`, message);
    }
    return res.json({ application: safeApplication(updated.rows[0], true) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/admin/applications/:id/tasks', requireRole('admin'), async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(422).json({ error: 'Task title is required.' });
    const result = await pool.query(
      `INSERT INTO growth_application_tasks(application_id,title,due_date,status,created_by)
       VALUES ($1,$2,$3,'pending',$4) RETURNING *`,
      [req.params.id, title, req.body.due_date || null, req.user.id],
    );
    return res.status(201).json({ task: result.rows[0] });
  } catch (err) { next(err); }
});

router.patch('/admin/tasks/:taskId', requireRole('admin'), async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid task status.' });
    const result = await pool.query(
      `UPDATE growth_application_tasks SET status=$1,
       completed_at=CASE WHEN $1='completed' THEN now() ELSE NULL END WHERE id=$2 RETURNING *`,
      [status, req.params.taskId],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Task not found.' });
    return res.json({ task: result.rows[0] });
  } catch (err) { next(err); }
});

router.get('/admin/settings', requireRole('admin'), async (req, res, next) => {
  try {
    const [settings, placements, links] = await Promise.all([
      pool.query("SELECT key,value,updated_at FROM settings WHERE key LIKE 'growth_application_%' ORDER BY key"),
      pool.query('SELECT * FROM growth_application_placements ORDER BY page_key'),
      pool.query('SELECT id,short_code,is_current,created_at,retired_at FROM growth_application_short_links ORDER BY created_at DESC'),
    ]);
    return res.json({ settings: settings.rows, placements: placements.rows, short_links: links.rows, question_bank_version: QUESTION_BANK_VERSION });
  } catch (err) { next(err); }
});

router.patch('/admin/settings', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const visibility = req.body.site_visibility;
    const responseDays = req.body.response_days;
    const placements = req.body.placements;
    if (visibility != null && !['visible', 'hidden'].includes(String(visibility))) return res.status(400).json({ error: 'site_visibility must be visible or hidden.' });
    if (responseDays != null && (!Number.isInteger(Number(responseDays)) || Number(responseDays) < 1 || Number(responseDays) > 60)) return res.status(400).json({ error: 'response_days must be between 1 and 60.' });
    if (placements != null && (!Array.isArray(placements) || placements.some((p) => !PLACEMENT_KEYS.has(String(p.page_key))))) return res.status(400).json({ error: 'placements contains an invalid page_key.' });

    await client.query('BEGIN');
    if (visibility != null) await client.query("UPDATE settings SET value=$1,updated_at=now() WHERE key='growth_application_site_visibility'", [String(visibility)]);
    if (responseDays != null) await client.query("UPDATE settings SET value=$1,updated_at=now() WHERE key='growth_application_response_days'", [String(Number(responseDays))]);
    if (placements) {
      for (const placement of placements) {
        await client.query('UPDATE growth_application_placements SET enabled=$1,updated_by=$2,updated_at=now() WHERE page_key=$3', [placement.enabled === true, req.user.id, String(placement.page_key)]);
      }
    }
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

router.post('/admin/short-link', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    let code = String(req.body.short_code || '').trim().toUpperCase();
    if (!code) code = newShortCode();
    if (!/^[A-Z0-9-]{4,40}$/.test(code)) return res.status(400).json({ error: 'short_code must be 4-40 letters, numbers or hyphens.' });

    await client.query('BEGIN');
    await client.query('UPDATE growth_application_short_links SET is_current=FALSE,retired_at=COALESCE(retired_at,now()) WHERE is_current=TRUE');
    const inserted = await client.query(
      'INSERT INTO growth_application_short_links(short_code,is_current,created_by) VALUES ($1,TRUE,$2) RETURNING *',
      [code, req.user.id],
    );
    await client.query("UPDATE settings SET value=$1,updated_at=now() WHERE key='growth_application_short_code'", [code]);
    await client.query('COMMIT');
    return res.status(201).json({ short_link: inserted.rows[0], url: `${siteUrl()}/grow/${encodeURIComponent(code)}` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505') return res.status(409).json({ error: 'That short code already exists. Historical codes are preserved.' });
    next(err);
  } finally { client.release(); }
});

// Historical codes stay valid after regeneration.
shortLinkRouter.get('/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    const result = await pool.query('SELECT short_code FROM growth_application_short_links WHERE short_code=$1', [code]);
    if (!result.rowCount) return res.status(404).send('Growth Application link not found.');
    return res.redirect(302, `${siteUrl()}/unplug-growth-application.html?code=${encodeURIComponent(code)}`);
  } catch (err) { next(err); }
});

module.exports = { router, shortLinkRouter, publicQuestionBank, validateDeepDiscovery, isYesNoPrompt };
