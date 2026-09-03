const crypto = require('crypto');
const express = require('express');
const pool = require('../db');
const { notifyAdminAsync, NOTIFY } = require('../utils/adminNotify');
const { requireRole } = require('../middleware/auth');
const { spamCheck } = require('../middleware/spamCheck');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const honeypot = require('../middleware/honeypot');
const { logActivity } = require('./activityLog');
const { sendEmail } = require('../utils/email');

const router = express.Router();

// Same SITE_URL convention the edition-claim emails use, so it follows the
// domain rather than hardcoding it a second time.
const SITE_URL = (process.env.SITE_URL || 'https://www.unplugnews.com').replace(/\/$/, '');

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
router.post('/jobs', publicSubmitLimiter, honeypot, spamCheck('job posting'), async (req, res, next) => {
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

    notifyAdminAsync({
      type: NOTIFY.DEAF_JOB,
      message: 'New Deaf Community vacancy awaiting approval',
      plural: '%n new Deaf Community vacancies awaiting approval',
      link: 'deafjobs',
      dedupeKey: 'deafjobs:pending',
    });
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
router.post('/passports', publicSubmitLimiter, honeypot, spamCheck('deaf passport'), async (req, res, next) => {
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
//
// Approved AND named. This POST needs no account, so without the status
// filter anyone on the internet could put text straight onto a live public
// page — see 111_passport_comment_moderation.sql.
//
// The name check is a second, independent guard. A name is required on every
// new comment, so only rows predating that rule can be nameless; this makes
// certain none of them can ever render as an unattributed comment, even if
// one is approved by mistake.
router.get('/passports/:id/comments', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, commenter_name, comment, created_at
       FROM deaf_passport_comments
       WHERE passport_id = $1 AND status = 'approved'
         AND COALESCE(TRIM(commenter_name), '') <> ''
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
router.post('/passports/:id/comments', publicSubmitLimiter, honeypot, spamCheck('passport comment'), async (req, res, next) => {
  try {
    const { commenterName, comment } = req.body;
    const text = (comment || '').trim();
    const name = (commenterName || '').trim();
    if (!text) return res.status(400).json({ error: 'A comment is required.' });
    if (text.length > 500) return res.status(400).json({ error: 'Comment is too long (max 500 characters).' });
    // A name is required. Comments on this site are attributed to a person —
    // nothing publishes as "Anonymous".
    if (!name) return res.status(400).json({ error: 'Please add your name — comments are shown with the name of the person who wrote them.' });
    if (name.length > 120) return res.status(400).json({ error: 'That name is too long (max 120 characters).' });

    // Only allow commenting on a live passport.
    const live = await pool.query(
      `SELECT id FROM deaf_passports WHERE id = $1 AND status = 'approved' AND expires_at > now()`,
      [req.params.id]
    );
    if (live.rows.length === 0) {
      return res.status(404).json({ error: 'That passport is not available for comments.' });
    }

    // status is left to its default of 'pending'. Never set here — a comment
    // that publishes itself is the bug this whole change exists to remove.
    await pool.query(
      `INSERT INTO deaf_passport_comments (passport_id, commenter_name, comment)
       VALUES ($1, $2, $3)`,
      [req.params.id, name, text]
    );
    // Says plainly that it is not live yet. Telling someone "Comment posted"
    // and then not showing it reads as the site being broken.
    res.status(201).json({
      message: 'Thank you — your comment has been sent for review and will appear once approved.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// SELF-SERVICE: view, edit, renew or remove a submission — by an emailed
// link, not a login. Neither table has a user_id; submitting has never
// required an account, which matters for an accessibility-focused feature
// and is kept exactly as it is here too. "Proving it's yours" is the same
// shape as the edition-download claim flow: a random token, minted lazily
// and emailed on request, rather than typed in from memory.
// ---------------------------------------------------------------------------

function generateManageToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Which fields the owner may edit, and the column each maps to. id, status,
// manage_token, created_at and expires_at are never client-settable — those
// are what the routes below govern, not what a PATCH body can reach.
const EDITABLE_FIELDS = {
  deaf_jobs: {
    businessName: 'business_name', title: 'title', description: 'description',
    applyEmail: 'apply_email', province: 'province', salaryRange: 'salary_range',
  },
  deaf_passports: {
    name: 'name', profileImageUrl: 'profile_image_url', skills: 'skills',
    certifications: 'certifications', communicationPreferences: 'communication_preferences',
    availability: 'availability',
  },
};
const OWNER_EMAIL_COLUMN = { deaf_jobs: 'apply_email', deaf_passports: 'email' };
const LABEL = { deaf_jobs: 'vacancy', deaf_passports: 'Opportunity Passport' };
const MANAGE_KIND = { deaf_jobs: 'job', deaf_passports: 'passport' };

// POST /deaf-community/{jobs,passports}/manage-link — { email }.
//
// Answers the same way whether or not anything matched — the response can't
// be used to learn whether a given address has a listing. A withdrawn
// listing is deliberately excluded: nothing to manage once it's gone.
function requestManageLink(table) {
  return async (req, res, next) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'Enter the email address you submitted with.' });

      const emailCol = OWNER_EMAIL_COLUMN[table];
      const found = await pool.query(
        `SELECT id, manage_token FROM ${table} WHERE lower(${emailCol}) = $1 AND status <> 'withdrawn'`,
        [email]
      );

      if (found.rows.length > 0) {
        const links = [];
        for (const row of found.rows) {
          // Minted lazily, on first request — see editionAccess.js's
          // generateToken() for the same reasoning applied to downloads.
          let token = row.manage_token;
          if (!token) {
            token = generateManageToken();
            await pool.query(`UPDATE ${table} SET manage_token = $1 WHERE id = $2`, [token, row.id]);
          }
          links.push(`${SITE_URL}/unplug-magazine?p=deafcommunity&manage=${MANAGE_KIND[table]}&token=${token}`);
        }
        // One email even if several listings match, not one per listing —
        // a member with three vacancies should get three links, not three
        // separate emails to find in their inbox.
        const plural = links.length === 1 ? '' : 's';
        await sendEmail({
          to: email,
          subject: `Manage your Unplug ${LABEL[table]}${plural}`,
          text: `Here ${links.length === 1 ? 'is the link' : 'are the links'} to view, edit, renew or remove your `
            + `Unplug ${LABEL[table]}${plural}:\n\n${links.join('\n')}\n\n`
            + `Each link works any time — keep it if you'll want to renew before it expires.`,
        }).catch(() => {}); // best-effort: a delivery hiccup must not turn into a 500 for the requester
      }

      res.json({ message: `If we have a ${LABEL[table]} submitted with that email address, we've sent a link to manage it.` });
    } catch (err) {
      next(err);
    }
  };
}
router.post('/jobs/manage-link', publicSubmitLimiter, requestManageLink('deaf_jobs'));
router.post('/passports/manage-link', publicSubmitLimiter, requestManageLink('deaf_passports'));

// GET /deaf-community/{jobs,passports}/manage/:token — the owner's own view.
// Unlike the public GET, this includes fields never shown publicly (the
// contact/verification email) and returns a row regardless of status, so a
// pending or expired listing is still visible to the person who submitted it.
function getManaged(table) {
  return async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT * FROM ${table} WHERE manage_token = $1`, [req.params.token]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'This link is not valid.' });
      res.json({ [table === 'deaf_jobs' ? 'job' : 'passport']: result.rows[0] });
    } catch (err) {
      next(err);
    }
  };
}
router.get('/jobs/manage/:token', getManaged('deaf_jobs'));
router.get('/passports/manage/:token', getManaged('deaf_passports'));

// PATCH /deaf-community/{jobs,passports}/manage/:token — edit. Only the
// allow-listed fields in EDITABLE_FIELDS are ever reachable from the body;
// an edited job/passport goes back to 'pending' so it is reviewed again
// before the new content goes live, same as any other content change.
function patchManaged(table) {
  return async (req, res, next) => {
    try {
      const sets = [];
      const values = [];
      for (const [bodyKey, column] of Object.entries(EDITABLE_FIELDS[table])) {
        if (req.body[bodyKey] === undefined) continue;
        values.push(req.body[bodyKey]);
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
      values.push(req.params.token);
      const result = await pool.query(
        `UPDATE ${table} SET ${sets.join(', ')}, status = 'pending'
          WHERE manage_token = $${values.length} AND status <> 'withdrawn'
          RETURNING id`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'This link is not valid.' });
      res.json({
        id: result.rows[0].id,
        message: `Updated. Your changes are back in review, same as a new submission, before they go live.`,
      });
    } catch (err) {
      next(err);
    }
  };
}
router.patch('/jobs/manage/:token', patchManaged('deaf_jobs'));
router.patch('/passports/manage/:token', patchManaged('deaf_passports'));

// POST /deaf-community/{jobs,passports}/manage/:token/renew — resets the
// 14-day window from now. Only a currently-approved (live) listing can be
// renewed; a pending or rejected one has no "live" period to extend, and a
// withdrawn one is gone on purpose.
function renewManaged(table) {
  return async (req, res, next) => {
    try {
      const result = await pool.query(
        `UPDATE ${table} SET expires_at = now() + interval '14 days'
          WHERE manage_token = $1 AND status = 'approved'
          RETURNING id, expires_at`,
        [req.params.token]
      );
      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'This can only be renewed while it is live.' });
      }
      res.json({ id: result.rows[0].id, expiresAt: result.rows[0].expires_at, message: 'Renewed for another 14 days.' });
    } catch (err) {
      next(err);
    }
  };
}
router.post('/jobs/manage/:token/renew', renewManaged('deaf_jobs'));
router.post('/passports/manage/:token/renew', renewManaged('deaf_passports'));

// DELETE /deaf-community/{jobs,passports}/manage/:token — "deactivate" and
// "delete" are treated as the one action a self-service link offers:
// immediate, permanent removal from the live board. Not a hard SQL DELETE —
// marked 'withdrawn' instead, so the row (and its manage_token, should the
// owner want a record of what they once submitted) is not simply gone.
function withdrawManaged(table) {
  return async (req, res, next) => {
    try {
      const result = await pool.query(
        `UPDATE ${table} SET status = 'withdrawn' WHERE manage_token = $1 AND status <> 'withdrawn' RETURNING id`,
        [req.params.token]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'This link is not valid.' });
      res.json({ id: result.rows[0].id, message: 'Removed from the board.' });
    } catch (err) {
      next(err);
    }
  };
}
router.delete('/jobs/manage/:token', withdrawManaged('deaf_jobs'));
router.delete('/passports/manage/:token', withdrawManaged('deaf_passports'));

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

// GET /deaf-community/admin/passport-comments/pending
router.get('/admin/passport-comments/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.passport_id, c.commenter_name, c.comment, c.created_at,
              p.name AS passport_name
         FROM deaf_passport_comments c
         LEFT JOIN deaf_passports p ON p.id = c.passport_id
        WHERE c.status = 'pending'
        ORDER BY c.created_at ASC`
    );
    res.json({ comments: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /deaf-community/admin/passport-comments/:id/:action
//
// Separate from moderationHandler below: that one resets a 14-day expiry
// window, which is meaningful for a job or a passport and meaningless for a
// comment. Sharing it would have silently added an expiry column requirement.
router.patch('/admin/passport-comments/:id/:action', requireRole('admin'), async (req, res, next) => {
  try {
    const action = req.params.action;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject.' });
    }
    const status = action === 'approve' ? 'approved' : 'rejected';
    const result = await pool.query(
      `UPDATE deaf_passport_comments
          SET status = $1, reviewed_at = now(), reviewed_by = $2
        WHERE id = $3 RETURNING id, comment`,
      [status, req.user.id, Number(req.params.id)]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Comment not found.' });

    await logActivity(req.user.id, `passport_comment_${status}`,
      `${status === 'approved' ? 'Approved' : 'Rejected'} passport comment #${result.rows[0].id}: `
      + `"${String(result.rows[0].comment).slice(0, 80)}"`).catch(() => {});

    res.json({ id: result.rows[0].id, status });
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
