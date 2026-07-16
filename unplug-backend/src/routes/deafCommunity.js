const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// The filter tags a job may carry. Kept server-side so the public POST can't
// invent arbitrary tags.
const JOB_FILTERS = [
  'deaf_friendly_employer',
  'sasl_interpreter_available',
  'whatsapp_applications',
  'email_applications',
  'remote_work',
  'no_experience_required',
  'graduate_opportunities',
  'full_time',
  'part_time',
];

function wordCount(str) {
  return (str || '').trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// JOBS
// ---------------------------------------------------------------------------

// GET /deaf-community/jobs — public, live (approved + not expired) vacancies.
// Optional ?filter=remote_work&province=Gauteng narrowing.
router.get('/jobs', async (req, res, next) => {
  try {
    const conditions = [`status = 'approved'`, `expires_at > now()`];
    const values = [];
    if (req.query.province) {
      values.push(req.query.province);
      conditions.push(`province = $${values.length}`);
    }
    if (req.query.filter && JOB_FILTERS.includes(req.query.filter)) {
      values.push(req.query.filter);
      conditions.push(`$${values.length} = ANY(filters)`);
    }
    const result = await pool.query(
      `SELECT id, business_name, title, description, apply_email, province, salary_range,
              filters, deaf_friendly_agreed, created_at, expires_at
       FROM deaf_jobs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC`,
      values
    );
    res.json({ jobs: result.rows, filterOptions: JOB_FILTERS });
  } catch (err) {
    next(err);
  }
});

// POST /deaf-community/jobs — public submission. Enters 'pending'; goes live
// (for 14 days) once an admin approves. The employer must agree they are a
// deaf-friendly employer, and the description is capped at 100 words.
router.post('/jobs', async (req, res, next) => {
  try {
    const { businessName, title, description, applyEmail, province, salaryRange, filters, deafFriendlyAgreed } = req.body;
    if (!businessName || !title || !description || !applyEmail) {
      return res.status(400).json({ error: 'businessName, title, description and applyEmail are required.' });
    }
    if (deafFriendlyAgreed !== true) {
      return res.status(400).json({ error: 'You must agree that you are a deaf-friendly employer to post a vacancy.' });
    }
    if (wordCount(description) > 100) {
      return res.status(400).json({ error: 'The description may not exceed 100 words.' });
    }
    const cleanFilters = Array.isArray(filters) ? filters.filter((f) => JOB_FILTERS.includes(f)) : [];

    const result = await pool.query(
      `INSERT INTO deaf_jobs (business_name, title, description, apply_email, province, salary_range, filters, deaf_friendly_agreed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING id`,
      [businessName.trim(), title.trim(), description.trim(), applyEmail.trim(), province || null, salaryRange || null, cleanFilters]
    );
    res.status(201).json({
      id: result.rows[0].id,
      message: 'Vacancy submitted for review. Once approved it goes live for 14 days.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// OPPORTUNITY PASSPORTS
// ---------------------------------------------------------------------------

// GET /deaf-community/passports — public, live passports. Never returns the
// private email.
router.get('/passports', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, profile_image_url, skills, certifications, communication_preferences,
              availability, created_at, expires_at
       FROM deaf_passports
       WHERE status = 'approved' AND expires_at > now()
       ORDER BY created_at DESC`
    );
    res.json({ passports: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /deaf-community/passports — public submission. Email is used for the
// verification process (admin approval) and is never shown publicly. Enters
// 'pending'; shows for 14 days once approved.
router.post('/passports', async (req, res, next) => {
  try {
    const { name, email, profileImageUrl, skills, certifications, communicationPreferences, availability } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required.' });
    }
    const result = await pool.query(
      `INSERT INTO deaf_passports (name, email, profile_image_url, skills, certifications, communication_preferences, availability)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [name.trim(), email.trim(), profileImageUrl || null, skills || null, certifications || null, communicationPreferences || null, availability || null]
    );
    res.status(201).json({
      id: result.rows[0].id,
      message: 'Passport submitted. We\'ll verify it via your email, then it shows for 14 days.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /deaf-community/passports/:id/comments — public comments on a passport.
router.get('/passports/:id/comments', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, commenter_name, comment, created_at
       FROM deaf_passport_comments
       WHERE passport_id = $1
       ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ comments: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /deaf-community/passports/:id/comments — public. The only interaction
// allowed on a passport is leaving a comment.
router.post('/passports/:id/comments', async (req, res, next) => {
  try {
    const { commenterName, comment } = req.body;
    const text = (comment || '').trim();
    if (!text) return res.status(400).json({ error: 'A comment is required.' });
    if (text.length > 500) return res.status(400).json({ error: 'Comment is too long (max 500 characters).' });

    // Only allow commenting on a live passport.
    const live = await pool.query(
      `SELECT id FROM deaf_passports WHERE id = $1 AND status = 'approved' AND expires_at > now()`,
      [req.params.id]
    );
    if (live.rows.length === 0) {
      return res.status(404).json({ error: 'That passport is not available for comments.' });
    }

    await pool.query(
      `INSERT INTO deaf_passport_comments (passport_id, commenter_name, comment)
       VALUES ($1, $2, $3)`,
      [req.params.id, (commenterName || '').trim() || null, text]
    );
    res.status(201).json({ message: 'Comment posted.' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// ADMIN moderation (approve / reject jobs and passports)
// ---------------------------------------------------------------------------
router.get('/admin/jobs/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, business_name, title, description, apply_email, province, salary_range, created_at
       FROM deaf_jobs WHERE status = 'pending' ORDER BY created_at ASC`
    );
    res.json({ jobs: result.rows });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/passports/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, skills, availability, created_at
       FROM deaf_passports WHERE status = 'pending' ORDER BY created_at ASC`
    );
    res.json({ passports: result.rows });
  } catch (err) {
    next(err);
  }
});

// Approving resets the 14-day window from the approval moment.
function moderationHandler(table) {
  return async (req, res, next) => {
    try {
      const action = req.params.action;
      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'action must be approve or reject.' });
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      const setExpiry = action === 'approve' ? ', expires_at = now() + interval \'14 days\'' : '';
      const result = await pool.query(
        `UPDATE ${table} SET status = $1${setExpiry} WHERE id = $2 RETURNING id`,
        [status, req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
      res.json({ id: result.rows[0].id, status });
    } catch (err) {
      next(err);
    }
  };
}
router.patch('/admin/jobs/:id/:action', requireRole('admin'), moderationHandler('deaf_jobs'));
router.patch('/admin/passports/:id/:action', requireRole('admin'), moderationHandler('deaf_passports'));

module.exports = router;
