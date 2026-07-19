const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const { publicSubmitLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// POST /claims/profile/:profileId — a member asserts a listing is theirs.
// Approval is a manual admin step: transferring a business listing on an
// unchecked say-so would let anyone take over someone else's page.
router.post('/profile/:profileId', requireAuth, publicSubmitLimiter, async (req, res, next) => {
  try {
    const profileId = Number(req.params.profileId);
    const message = (req.body.message || '').trim();
    if (!Number.isInteger(profileId)) {
      return res.status(400).json({ error: 'A valid listing id is required.' });
    }
    const profile = await pool.query('SELECT user_id FROM profiles WHERE id = $1', [profileId]);
    if (profile.rowCount === 0) {
      return res.status(404).json({ error: 'That listing no longer exists.' });
    }
    if (profile.rows[0].user_id === req.user.id) {
      return res.status(409).json({ error: 'This listing is already yours.' });
    }
    await pool.query(
      `INSERT INTO profile_claims (profile_id, user_id, message)
       VALUES ($1, $2, $3)
       ON CONFLICT (profile_id, user_id) DO UPDATE
         SET message = EXCLUDED.message, status = 'pending', created_at = now(), reviewed_at = NULL`,
      [profileId, req.user.id, message || null]
    );
    res.status(201).json({ message: 'Thanks — we\'ve received your claim and will be in touch once it\'s reviewed.' });
  } catch (err) {
    next(err);
  }
});

// GET /claims/mine — the member's own claims and where each one stands.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cl.id, cl.status, cl.created_at, p.display_name AS listing, p.slug
         FROM profile_claims cl
         JOIN profiles p ON p.id = cl.profile_id
        WHERE cl.user_id = $1
        ORDER BY cl.created_at DESC`,
      [req.user.id]
    );
    res.json({ claims: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /claims/pending — admin queue.
router.get('/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cl.id, cl.message, cl.created_at, cl.profile_id,
              p.display_name AS listing, p.slug,
              u.email AS claimant_email, u.id AS claimant_id,
              owner.email AS current_owner_email
         FROM profile_claims cl
         JOIN profiles p ON p.id = cl.profile_id
         JOIN users u ON u.id = cl.user_id
         LEFT JOIN users owner ON owner.id = p.user_id
        WHERE cl.status = 'pending'
        ORDER BY cl.created_at ASC`
    );
    res.json({ claims: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /claims/:id/status — admin decision. Approving transfers ownership
// of the listing, so the claim update and the ownership change happen in one
// transaction: a half-applied approval would leave the listing in limbo.
router.patch('/:id/status', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const claimId = Number(req.params.id);
    const status = (req.body.status || '').trim();
    if (!Number.isInteger(claimId)) {
      return res.status(400).json({ error: 'A valid claim id is required.' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "Status must be 'approved' or 'rejected'." });
    }

    await client.query('BEGIN');
    const claim = await client.query(
      'SELECT profile_id, user_id FROM profile_claims WHERE id = $1 FOR UPDATE',
      [claimId]
    );
    if (claim.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That claim no longer exists.' });
    }
    await client.query(
      'UPDATE profile_claims SET status = $1, reviewed_at = now() WHERE id = $2',
      [status, claimId]
    );
    if (status === 'approved') {
      await client.query(
        'UPDATE profiles SET user_id = $1 WHERE id = $2',
        [claim.rows[0].user_id, claim.rows[0].profile_id]
      );
      // Any other open claim on the same listing is now moot.
      await client.query(
        `UPDATE profile_claims SET status = 'rejected', reviewed_at = now()
          WHERE profile_id = $1 AND id <> $2 AND status = 'pending'`,
        [claim.rows[0].profile_id, claimId]
      );
    }
    await client.query('COMMIT');
    // Transferring a listing to a different owner is the most consequential
    // action in the admin dashboard, so it always leaves a trail.
    logActivity(
      req.user.id,
      status === 'approved' ? 'claim_approved_listing_transferred' : 'claim_rejected',
      `claim ${claimId} · listing ${claim.rows[0].profile_id} · to user ${claim.rows[0].user_id}`
    );
    res.json({ claim: { id: claimId, status } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
