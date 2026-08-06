// Members, Profile Social Interaction & Community System — Phase 6:
// Public vs Private Profile Analytics.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /profile-analytics/:userId/public — public, no auth required (a
// follower — or anyone — can see this, same visibility as the profile
// page itself). Never includes phone/email/address; see
// get_public_profile_analytics() in 089_profile_analytics.sql for what
// it actually returns.
router.get('/:userId/public', async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    const exists = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ error: 'That member no longer exists.' });
    }
    const result = await pool.query('SELECT * FROM get_public_profile_analytics($1)', [userId]);
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /profile-analytics/me/private?range=30 — auth-only, always the
// signed-in member's OWN data (never :userId — a private dashboard is
// never something to fetch on someone else's behalf, so there's no
// parameter to typo or spoof). Engagement trend, follower growth,
// ranking history, recognition breakdown — everything the public
// endpoint above deliberately does not expose.
router.get('/me/private', requireAuth, async (req, res, next) => {
  try {
    const range = [7, 30, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 30;
    const userId = req.user.id;
    const profile = await pool.query('SELECT id FROM profiles WHERE user_id = $1 ORDER BY id LIMIT 1', [userId]);
    const profileId = profile.rows[0] ? profile.rows[0].id : null;

    const [
      publicStats, dailyPoints, followerGrowth, rankHistory, recognitionBreakdown,
    ] = await Promise.all([
      pool.query('SELECT * FROM get_public_profile_analytics($1)', [userId]),
      pool.query(
        `SELECT DATE(earned_at) AS day, SUM(total_points)::INTEGER AS points, COUNT(*)::INTEGER AS actions
           FROM participation_points
          WHERE user_id = $1 AND is_reversed = FALSE AND earned_at >= now() - ($2 || ' days')::INTERVAL
          GROUP BY DATE(earned_at) ORDER BY day ASC`,
        [userId, range]
      ),
      pool.query(
        `SELECT DATE(created_at) AS day, COUNT(*)::INTEGER AS new_followers
           FROM member_follows
          WHERE followed_user_id = $1 AND created_at >= now() - ($2 || ' days')::INTERVAL
          GROUP BY DATE(created_at) ORDER BY day ASC`,
        [userId, range]
      ),
      pool.query(
        `SELECT rank_position, score_value, snapshot_at
           FROM ranking_history
          WHERE user_id = $1 AND ranking_type = 'overall' AND period_type = 'lifetime'
          ORDER BY snapshot_at DESC LIMIT 20`,
        [userId]
      ),
      pool.query(
        `SELECT recognition_type, COUNT(*)::INTEGER AS n
           FROM recognitions WHERE to_user_id = $1 AND is_reversed = FALSE
          GROUP BY recognition_type ORDER BY n DESC`,
        [userId]
      ),
    ]);

    res.json({
      range,
      ...publicStats.rows[0],
      profileId,
      dailyPoints: dailyPoints.rows,
      followerGrowth: followerGrowth.rows,
      rankHistory: rankHistory.rows,
      recognitionBreakdown: recognitionBreakdown.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
