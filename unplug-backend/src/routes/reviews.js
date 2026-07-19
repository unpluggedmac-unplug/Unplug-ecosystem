const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const honeypot = require('../middleware/honeypot');

const router = express.Router();

const MAX_REVIEW_LENGTH = 1500;

// Reviewer names follow the same rule as comments: a profile display name if
// they have one, otherwise the local part of their email. Addresses are never
// exposed. Scalar subquery, not a join — a member can own several profiles.
const REVIEWER_SQL = `
  COALESCE(
    NULLIF((SELECT pr.display_name FROM profiles pr
             WHERE pr.user_id = r.user_id ORDER BY pr.id LIMIT 1), ''),
    split_part(u.email, '@', 1)
  ) AS reviewer`;

// GET /reviews/profile/:profileId — public. Approved reviews plus the
// aggregate rating, so a listing page can show "4.6 from 12 reviews".
router.get('/profile/:profileId', async (req, res, next) => {
  try {
    const profileId = Number(req.params.profileId);
    if (!Number.isInteger(profileId)) {
      return res.status(400).json({ error: 'A valid listing id is required.' });
    }
    const reviews = await pool.query(
      `SELECT r.id, r.rating, r.body, r.created_at, ${REVIEWER_SQL}
         FROM profile_reviews r
         JOIN users u ON u.id = r.user_id
        WHERE r.profile_id = $1 AND r.status = 'approved'
        ORDER BY r.created_at DESC`,
      [profileId]
    );
    const summary = await pool.query(
      `SELECT COUNT(*)::int AS count, ROUND(AVG(rating)::numeric, 1) AS average
         FROM profile_reviews
        WHERE profile_id = $1 AND status = 'approved'`,
      [profileId]
    );
    res.json({
      reviews: reviews.rows,
      count: summary.rows[0].count,
      average: summary.rows[0].average === null ? null : Number(summary.rows[0].average),
    });
  } catch (err) {
    next(err);
  }
});

// POST /reviews/profile/:profileId — members only. Re-reviewing updates the
// existing review rather than adding a second one, and sends it back through
// moderation because the content changed.
router.post('/profile/:profileId', requireAuth, publicSubmitLimiter, honeypot, async (req, res, next) => {
  try {
    const profileId = Number(req.params.profileId);
    const rating = Number(req.body.rating);
    const body = (req.body.body || '').trim();
    if (!Number.isInteger(profileId)) {
      return res.status(400).json({ error: 'A valid listing id is required.' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Choose a rating from 1 to 5 stars.' });
    }
    if (body.length > MAX_REVIEW_LENGTH) {
      return res.status(400).json({ error: `Reviews are limited to ${MAX_REVIEW_LENGTH} characters.` });
    }
    const profile = await pool.query('SELECT user_id FROM profiles WHERE id = $1', [profileId]);
    if (profile.rowCount === 0) {
      return res.status(404).json({ error: 'That listing no longer exists.' });
    }
    // Reviewing your own listing would make ratings meaningless.
    if (profile.rows[0].user_id === req.user.id) {
      return res.status(403).json({ error: 'You can\'t review your own listing.' });
    }
    await pool.query(
      `INSERT INTO profile_reviews (profile_id, user_id, rating, body)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (profile_id, user_id) DO UPDATE
         SET rating = EXCLUDED.rating,
             body = EXCLUDED.body,
             status = 'pending',
             created_at = now(),
             reviewed_at = NULL`,
      [profileId, req.user.id, rating, body || null]
    );
    res.status(201).json({ message: 'Thanks — your review has been sent for review and will appear once approved.' });
  } catch (err) {
    next(err);
  }
});

// GET /reviews/mine/:profileId — lets the frontend show a member their own
// pending review, which isn't in the public list yet.
router.get('/mine/:profileId', requireAuth, async (req, res, next) => {
  try {
    const profileId = Number(req.params.profileId);
    if (!Number.isInteger(profileId)) {
      return res.status(400).json({ error: 'A valid listing id is required.' });
    }
    const result = await pool.query(
      'SELECT id, rating, body, status, created_at FROM profile_reviews WHERE profile_id = $1 AND user_id = $2',
      [profileId, req.user.id]
    );
    res.json({ review: result.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// GET /reviews/pending — admin moderation queue.
router.get('/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.rating, r.body, r.created_at, r.profile_id,
              p.display_name AS listing, p.slug,
              u.email AS reviewer_email, ${REVIEWER_SQL}
         FROM profile_reviews r
         JOIN users u ON u.id = r.user_id
         JOIN profiles p ON p.id = r.profile_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at ASC`
    );
    res.json({ reviews: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /reviews/:id/status — admin approves or rejects.
router.patch('/:id/status', requireRole('admin'), async (req, res, next) => {
  try {
    const reviewId = Number(req.params.id);
    const status = (req.body.status || '').trim();
    if (!Number.isInteger(reviewId)) {
      return res.status(400).json({ error: 'A valid review id is required.' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "Status must be 'approved' or 'rejected'." });
    }
    const result = await pool.query(
      'UPDATE profile_reviews SET status = $1, reviewed_at = now() WHERE id = $2 RETURNING id, status',
      [status, reviewId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'That review no longer exists.' });
    res.json({ review: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /reviews/:id — the reviewer can withdraw their own; admins any.
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const reviewId = Number(req.params.id);
    if (!Number.isInteger(reviewId)) {
      return res.status(400).json({ error: 'A valid review id is required.' });
    }
    const owner = await pool.query('SELECT user_id FROM profile_reviews WHERE id = $1', [reviewId]);
    if (owner.rowCount === 0) return res.status(404).json({ error: 'That review no longer exists.' });
    if (owner.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only remove your own review.' });
    }
    await pool.query('DELETE FROM profile_reviews WHERE id = $1', [reviewId]);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
