// Members, Profile Social Interaction & Community System — Phase 6:
// Public vs Private Profile Analytics.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isCommunityFeatureEnabled } = require('../utils/communitySettings');

const router = express.Router();

// GET /profile-analytics/:userId/public — public, no auth required (a
// follower — or anyone — can see this, same visibility as the profile
// page itself). Never includes phone/email/address; see
// get_public_profile_analytics() in 089_profile_analytics.sql for what
// it actually returns. Admin-configurable site-wide via
// public_analytics_visible (092_admin_moderation.sql) — when off, returns
// { visible: false } rather than an error, so the frontend can hide the
// stat row cleanly instead of showing a failure state.
router.get('/:userId/public', async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    if (!(await isCommunityFeatureEnabled('public_analytics_visible'))) {
      return res.json({ visible: false });
    }
    const exists = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ error: 'That member no longer exists.' });
    }
    const result = await pool.query('SELECT * FROM get_public_profile_analytics($1)', [userId]);
    res.json({ visible: true, ...result.rows[0] });
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
    const profile = await pool.query('SELECT id,slug FROM profiles WHERE user_id = $1 ORDER BY id LIMIT 1', [userId]);
    const profileId = profile.rows[0] ? profile.rows[0].id : null;
    // Profile detail views were historically recorded as `profile-<slug>`
    // page paths. Keep reading that real history instead of pretending the
    // newer entity_type/entity_id fields were present before they existed.
    const profilePath = profile.rows[0] ? `profile-${profile.rows[0].slug}` : null;

    const [
      publicStats, dailyPoints, followerGrowth, rankHistory, recognitionBreakdown,
      audienceSummary, dailyAudience, topArticles,
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
           FROM recognitions
          WHERE to_user_id = $1 AND is_reversed = FALSE
            AND created_at >= now() - ($2 || ' days')::INTERVAL
          GROUP BY recognition_type ORDER BY n DESC`,
        [userId, range]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE ($2::INTEGER IS NOT NULL AND e.entity_type='profile' AND e.entity_id=$2)
                OR ($3::TEXT IS NOT NULL AND e.page_path=$3)
           )::INTEGER AS profile_views,
           COUNT(DISTINCT e.visitor_id) FILTER (
             WHERE ($2::INTEGER IS NOT NULL AND e.entity_type='profile' AND e.entity_id=$2)
                OR ($3::TEXT IS NOT NULL AND e.page_path=$3)
           )::INTEGER AS profile_visitors,
           COUNT(*) FILTER (WHERE a.author_user_id=$1)::INTEGER AS article_reads,
           COUNT(DISTINCT e.visitor_id) FILTER (WHERE a.author_user_id=$1)::INTEGER AS article_readers
         FROM analytics_events e
         LEFT JOIN articles a
           ON e.entity_type='article' AND e.entity_id=a.id
        WHERE e.event_name='page_view'
          AND e.occurred_at >= now() - ($4 || ' days')::INTERVAL
          AND e.user_id IS DISTINCT FROM $1`,
        [userId, profileId, profilePath, range]
      ),
      pool.query(
        `SELECT DATE(e.occurred_at) AS day,
                COUNT(*) FILTER (
                  WHERE ($2::INTEGER IS NOT NULL AND e.entity_type='profile' AND e.entity_id=$2)
                     OR ($3::TEXT IS NOT NULL AND e.page_path=$3)
                )::INTEGER AS profile_views,
                COUNT(*) FILTER (WHERE a.author_user_id=$1)::INTEGER AS article_reads
           FROM analytics_events e
           LEFT JOIN articles a
             ON e.entity_type='article' AND e.entity_id=a.id
          WHERE e.event_name='page_view'
            AND e.occurred_at >= now() - ($4 || ' days')::INTERVAL
            AND e.user_id IS DISTINCT FROM $1
            AND (
              ($2::INTEGER IS NOT NULL AND e.entity_type='profile' AND e.entity_id=$2)
              OR ($3::TEXT IS NOT NULL AND e.page_path=$3)
              OR a.author_user_id=$1
            )
          GROUP BY DATE(e.occurred_at)
          ORDER BY day ASC`,
        [userId, profileId, profilePath, range]
      ),
      pool.query(
        `SELECT a.id AS article_id,a.title,
                COUNT(*)::INTEGER AS reads,
                COUNT(DISTINCT e.visitor_id)::INTEGER AS readers
           FROM analytics_events e
           JOIN articles a ON e.entity_type='article' AND e.entity_id=a.id
          WHERE e.event_name='page_view'
            AND a.author_user_id=$1
            AND e.occurred_at >= now() - ($2 || ' days')::INTERVAL
            AND e.user_id IS DISTINCT FROM $1
          GROUP BY a.id,a.title
          ORDER BY reads DESC,a.id ASC
          LIMIT 5`,
        [userId, range]
      ),
    ]);

    const audience = audienceSummary.rows[0];

    res.json({
      range,
      ...publicStats.rows[0],
      profileId,
      dailyPoints: dailyPoints.rows,
      followerGrowth: followerGrowth.rows,
      rankHistory: rankHistory.rows,
      recognitionBreakdown: recognitionBreakdown.rows,
      audience: {
        profileViews: audience.profile_views,
        profileVisitors: audience.profile_visitors,
        articleReads: audience.article_reads,
        articleReaders: audience.article_readers,
      },
      dailyAudience: dailyAudience.rows,
      topArticles: topArticles.rows.map((article) => ({
        articleId: article.article_id,
        title: article.title,
        reads: article.reads,
        readers: article.readers,
      })),
      audienceNote: 'Counts only visits recorded after analytics consent. Your own signed-in views are excluded, so actual reach may be higher.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
