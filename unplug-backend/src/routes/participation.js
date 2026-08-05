// Participation Engine — Stage F: the HTTP surface for everything built
// in Stages A-E.
//
// This replaces the uploaded spec's Deno/Supabase Edge Functions
// (action, award-points, get-dashboard, get-leaderboard, get-homepage,
// process-referral, sync-user, ...) with plain Express routes, matching
// every other route file in this codebase: pool.query() against the
// participation_* SQL functions, auth via requireAuth/requireRole (not
// a Supabase JWT), errors via next(err).
const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function asInt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// PUBLIC — no sign-in required.
// ---------------------------------------------------------------------------

// GET /participation/status-levels — the member status ladder, for
// rendering progress UI anywhere on the site.
router.get('/status-levels', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT code, label, emoji, rank_order, min_score, min_days_since_join, min_active_months, description FROM member_status_levels ORDER BY rank_order ASC'
    );
    res.json({ statusLevels: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /participation/recognition-types — the 11 recognition badges.
router.get('/recognition-types', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT code, label, emoji, description FROM recognition_types WHERE is_enabled = TRUE ORDER BY sort_order ASC'
    );
    res.json({ recognitionTypes: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /participation/leaderboard?type=overall|momentum|recognition|contribution&limit=&offset=
router.get('/leaderboard', async (req, res, next) => {
  try {
    const type = ['overall', 'momentum', 'recognition', 'contribution'].includes(req.query.type)
      ? req.query.type : 'overall';
    const limit = Math.min(asInt(req.query.limit) || 50, 100);
    const offset = Math.max(asInt(req.query.offset) || 0, 0);
    const result = await pool.query('SELECT * FROM get_leaderboard($1, $2, $3)', [type, limit, offset]);
    res.json({ leaderboard: result.rows, type, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /participation/leaderboard/movers — the biggest recent climbers.
router.get('/leaderboard/movers', async (req, res, next) => {
  try {
    const limit = Math.min(asInt(req.query.limit) || 10, 50);
    const result = await pool.query('SELECT * FROM get_biggest_movers($1)', [limit]);
    res.json({ movers: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /participation/homepage — today's "Unplug Today" modules. Auto-
// calculates on first request of a new day if the scheduler hasn't run
// yet (see get_daily_homepage in 075_rankings_homepage.sql).
router.get('/homepage', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT get_daily_homepage() AS payload');
    res.json(result.rows[0].payload);
  } catch (err) {
    next(err);
  }
});

// GET /participation/homepage/sponsor/:placementCode — the active
// sponsor for a homepage placement, if any ("Presented by ...").
router.get('/homepage/sponsor/:placementCode', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM get_active_sponsor_campaign($1)', [req.params.placementCode]);
    res.json({ sponsor: result.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// POST /participation/sponsor/:campaignId/track — body { eventType }.
// Public: fired by the frontend when a sponsored placement is shown or
// clicked, not gated behind auth.
router.post('/sponsor/:campaignId/track', async (req, res, next) => {
  try {
    const campaignId = asInt(req.params.campaignId);
    const eventType = req.body.eventType;
    if (!campaignId) return res.status(400).json({ error: 'A valid campaign id is required.' });
    if (!['impression', 'click', 'mission', 'profile_view'].includes(eventType)) {
      return res.status(400).json({ error: 'eventType must be one of impression, click, mission, profile_view.' });
    }
    await pool.query('SELECT track_sponsor_impression($1, $2)', [campaignId, eventType]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// AUTHENTICATED — the signed-in member's own participation.
// ---------------------------------------------------------------------------

// POST /participation/action — the single entry point for every
// standard point-earning action (mirrors the uploaded spec's `action`
// Edge Function). Body: { actionCode, contentType?, contentId?, contentOwner? }
router.post('/action', requireAuth, async (req, res, next) => {
  try {
    const { actionCode, contentType, contentId, contentOwner } = req.body;
    if (!actionCode) return res.status(400).json({ error: 'actionCode is required.' });

    const result = await pool.query(
      'SELECT * FROM award_points($1, $2, $3, $4, $5)',
      [req.user.id, actionCode, contentType || null, contentId != null ? asInt(contentId) : null, contentOwner != null ? asInt(contentOwner) : null]
    );
    const row = result.rows[0];
    if (!row.success) {
      return res.json({ success: false, pointsEarned: 0, blockedReason: row.blocked_reason });
    }

    const missionResult = await pool.query('SELECT update_mission_progress($1, $2) AS n', [req.user.id, actionCode]);
    await pool.query('SELECT sync_achievements($1)', [req.user.id]);

    res.json({
      success: true,
      pointsEarned: row.points_earned,
      missionsCompleted: missionResult.rows[0].n,
    });
  } catch (err) {
    next(err);
  }
});

// GET /participation/dashboard — the full "My Unplug" payload.
router.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    await pool.query('SELECT ensure_member_participation_profile($1)', [userId]);
    await pool.query('SELECT assign_daily_missions($1)', [userId]);

    const [profile, score, statusHistory, statusLevels, streak, achievements, passport, missions, myRankings, notifications, recognitionCounts] = await Promise.all([
      pool.query('SELECT referral_code, show_on_leaderboard FROM member_participation_profiles WHERE user_id = $1', [userId]),
      pool.query('SELECT * FROM score_cache WHERE user_id = $1', [userId]),
      pool.query(
        `SELECT msh.status_code, sl.label, sl.emoji, sl.rank_order, msh.achieved_at
           FROM member_status_history msh JOIN member_status_levels sl ON sl.code = msh.status_code
          WHERE msh.user_id = $1 AND msh.is_active_status = TRUE`,
        [userId]
      ),
      pool.query('SELECT code, label, emoji, rank_order, min_score, min_days_since_join, min_active_months FROM member_status_levels ORDER BY rank_order ASC'),
      pool.query('SELECT current_streak_days, longest_streak_days FROM user_streaks WHERE user_id = $1', [userId]),
      pool.query(
        `SELECT a.code, a.label, a.description, a.emoji, a.points_reward, ua.earned_at
           FROM user_achievements ua JOIN achievements a ON a.code = ua.achievement_code
          WHERE ua.user_id = $1 ORDER BY ua.earned_at DESC`,
        [userId]
      ),
      pool.query(
        `SELECT pi.code, pi.label, pi.emoji, pi.category, (up.user_id IS NOT NULL) AS earned, up.earned_at
           FROM passport_items pi LEFT JOIN user_passport up ON up.passport_code = pi.code AND up.user_id = $1
          WHERE pi.is_enabled = TRUE ORDER BY pi.sort_order ASC`,
        [userId]
      ),
      pool.query(
        `SELECT um.mission_code, m.title, m.description, m.points_reward, m.target_count, um.progress_count, um.is_completed
           FROM user_missions um JOIN missions m ON m.code = um.mission_code
          WHERE um.user_id = $1 AND um.assigned_date = CURRENT_DATE`,
        [userId]
      ),
      pool.query('SELECT ranking_type, rank_position, rank_movement, score_value FROM rankings WHERE user_id = $1', [userId]),
      pool.query('SELECT id, type, title, body, link_url, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]),
      pool.query('SELECT * FROM recognition_counts WHERE user_id = $1', [userId]),
    ]);

    const currentRank = statusHistory.rows[0]?.rank_order ?? 0;
    const nextStatus = statusLevels.rows.find((s) => s.rank_order > currentRank) || null;

    res.json({
      profile: profile.rows[0] || null,
      score: score.rows[0] || null,
      currentStatus: statusHistory.rows[0] || null,
      nextStatus,
      streak: streak.rows[0] || { current_streak_days: 0, longest_streak_days: 0 },
      achievements: achievements.rows,
      passport: passport.rows,
      todayMissions: missions.rows,
      rankings: myRankings.rows,
      notifications: notifications.rows,
      recognitionCounts: recognitionCounts.rows[0] || null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /participation/referrals — the member's own referral code + who
// they've brought in so far.
router.get('/referrals', requireAuth, async (req, res, next) => {
  try {
    const profile = await pool.query('SELECT * FROM ensure_member_participation_profile($1)', [req.user.id]);
    const referrals = await pool.query(
      `SELECT mr.status, mr.registered_at, mr.qualified_at, COALESCE(dp.display_name, SPLIT_PART(u.email, '@', 1)) AS referred_display_name
         FROM member_referrals mr
         JOIN users u ON u.id = mr.referred_user_id
         LEFT JOIN profiles dp ON dp.user_id = u.id AND dp.status = 'approved'
        WHERE mr.referrer_user_id = $1
        ORDER BY mr.registered_at DESC`,
      [req.user.id]
    );
    res.json({
      referralCode: profile.rows[0].referral_code,
      referrals: referrals.rows,
      totalRegistered: referrals.rows.length,
      totalQualified: referrals.rows.filter((r) => r.status === 'qualified').length,
    });
  } catch (err) {
    next(err);
  }
});

// POST /participation/referrals/register — body { referralCode }. Called
// by the frontend right after a new member finishes signing up, if they
// arrived via someone's referral link (the code is carried through
// sessionStorage across the signup flow — see unplug-participation-sdk.js).
router.post('/referrals/register', requireAuth, async (req, res, next) => {
  try {
    const { referralCode } = req.body;
    if (!referralCode) return res.status(400).json({ error: 'referralCode is required.' });

    const result = await pool.query(
      `SELECT * FROM process_member_referral($1, 'registered', $2)`,
      [referralCode, req.user.id]
    );
    const row = result.rows[0];
    if (!row.success) {
      return res.status(400).json({ error: row.blocked_reason });
    }
    res.status(201).json({ success: true, pointsEarnedByReferrer: row.points_earned });
  } catch (err) {
    next(err);
  }
});

// POST /participation/recognitions — body { toUserId, recognitionType, message?, isPublic? }
router.post('/recognitions', requireAuth, async (req, res, next) => {
  try {
    const toUserId = asInt(req.body.toUserId);
    const { recognitionType, message, isPublic } = req.body;
    if (!toUserId || !recognitionType) {
      return res.status(400).json({ error: 'toUserId and recognitionType are required.' });
    }
    const result = await pool.query(
      'SELECT * FROM process_recognition($1, $2, $3, $4, $5)',
      [req.user.id, toUserId, recognitionType, message || null, isPublic !== false]
    );
    const row = result.rows[0];
    if (!row.success) {
      return res.status(400).json({ error: row.blocked_reason });
    }
    res.status(201).json({ success: true, recognitionId: row.recognition_id });
  } catch (err) {
    next(err);
  }
});

// GET /participation/recognitions/:userId — public recognitions received
// by a member (for showing on a profile page).
router.get('/recognitions/:userId', async (req, res, next) => {
  try {
    const userId = asInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'A valid user id is required.' });
    const result = await pool.query(
      `SELECT rec.recognition_type, rt.label, rt.emoji, rec.message, rec.created_at,
              COALESCE(dp.display_name, SPLIT_PART(u.email, '@', 1)) AS from_display_name
         FROM recognitions rec
         JOIN recognition_types rt ON rt.code = rec.recognition_type
         JOIN users u ON u.id = rec.from_user_id
         LEFT JOIN profiles dp ON dp.user_id = u.id AND dp.status = 'approved'
        WHERE rec.to_user_id = $1 AND rec.is_public = TRUE AND rec.is_reversed = FALSE
        ORDER BY rec.created_at DESC LIMIT 50`,
      [userId]
    );
    res.json({ recognitions: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /participation/notifications/read — body { ids?: number[] }. No
// ids = mark everything read.
router.post('/notifications/read', requireAuth, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(asInt).filter(Boolean) : null;
    if (ids && ids.length) {
      await pool.query(
        'UPDATE notifications SET is_read = TRUE, read_at = now() WHERE user_id = $1 AND id = ANY($2::INTEGER[])',
        [req.user.id, ids]
      );
    } else {
      await pool.query('UPDATE notifications SET is_read = TRUE, read_at = now() WHERE user_id = $1 AND is_read = FALSE', [req.user.id]);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// ADMIN
// ---------------------------------------------------------------------------

// POST /participation/admin/award-points — body { userId, points, reason }
router.post('/admin/award-points', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = asInt(req.body.userId);
    const points = asInt(req.body.points);
    const { reason } = req.body;
    if (!userId || !points || !reason) {
      return res.status(400).json({ error: 'userId, a non-zero integer points, and a reason are all required.' });
    }
    const result = await pool.query('SELECT * FROM admin_award_points($1, $2, $3, $4)', [userId, req.user.id, points, reason]);
    res.json({ success: result.rows[0].success });
  } catch (err) {
    next(err);
  }
});

// POST /participation/admin/reverse-points — body { txId, reason }
router.post('/admin/reverse-points', requireRole('admin'), async (req, res, next) => {
  try {
    const txId = asInt(req.body.txId);
    const { reason } = req.body;
    if (!txId || !reason) return res.status(400).json({ error: 'txId and reason are required.' });
    const result = await pool.query('SELECT reverse_points($1, $2, $3) AS ok', [txId, req.user.id, reason]);
    if (!result.rows[0].ok) {
      return res.status(400).json({ error: 'That transaction was not found, or was already reversed.' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /participation/admin/sync/:userId — full resync after a bulk
// import or a manual correction.
router.post('/admin/sync/:userId', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = asInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'A valid user id is required.' });

    await pool.query('SELECT recalculate_score_cache($1)', [userId]);
    const achCount = await pool.query('SELECT sync_achievements($1) AS n', [userId]);
    const statusResult = await pool.query('SELECT check_and_update_status($1) AS result', [userId]);

    res.json({
      success: true,
      achievementsAwarded: achCount.rows[0].n,
      statusResult: statusResult.rows[0].result,
    });
  } catch (err) {
    next(err);
  }
});

// -- Sponsorships (the brands themselves) + campaigns (admin) --

// GET /participation/admin/sponsorships
router.get('/admin/sponsorships', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM sponsorships ORDER BY sponsor_name ASC');
    res.json({ sponsorships: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /participation/admin/sponsorships — body { sponsorName, sponsorLogoUrl?, sponsorUrl?, contactName?, contactEmail? }
router.post('/admin/sponsorships', requireRole('admin'), async (req, res, next) => {
  try {
    const { sponsorName, sponsorLogoUrl, sponsorUrl, contactName, contactEmail } = req.body;
    if (!sponsorName) return res.status(400).json({ error: 'sponsorName is required.' });
    const result = await pool.query(
      `INSERT INTO sponsorships (sponsor_name, sponsor_logo_url, sponsor_url, contact_name, contact_email)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [sponsorName, sponsorLogoUrl || null, sponsorUrl || null, contactName || null, contactEmail || null]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    next(err);
  }
});

// GET /participation/admin/sponsor-campaigns
router.get('/admin/sponsor-campaigns', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT sc.*, sp.sponsor_name FROM sponsor_campaigns sc
         JOIN sponsorships sp ON sp.id = sc.sponsorship_id
        ORDER BY sc.created_at DESC`
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /participation/admin/sponsor-campaigns — body { sponsorshipId, campaignType, campaignLabel, placementCode, startsAt, endsAt }
router.post('/admin/sponsor-campaigns', requireRole('admin'), async (req, res, next) => {
  try {
    const { sponsorshipId, campaignType, campaignLabel, placementCode, startsAt, endsAt } = req.body;
    if (!sponsorshipId || !campaignType || !campaignLabel || !placementCode || !startsAt || !endsAt) {
      return res.status(400).json({ error: 'sponsorshipId, campaignType, campaignLabel, placementCode, startsAt and endsAt are all required.' });
    }
    const result = await pool.query(
      `INSERT INTO sponsor_campaigns (sponsorship_id, campaign_type, campaign_label, placement_code, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [asInt(sponsorshipId), campaignType, campaignLabel, placementCode, startsAt, endsAt]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    next(err);
  }
});

// PATCH /participation/admin/sponsor-campaigns/:id — partial update. Any of
// campaignLabel, placementCode, startsAt, endsAt, isActive. Used both for
// editing a campaign's details and for pausing/resuming it (isActive)
// without deleting it.
router.patch('/admin/sponsor-campaigns/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const campaignId = asInt(req.params.id);
    if (!campaignId) return res.status(400).json({ error: 'A valid campaign id is required.' });

    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

    if (req.body.campaignLabel !== undefined) set('campaign_label', req.body.campaignLabel);
    if (req.body.placementCode !== undefined) set('placement_code', req.body.placementCode);
    if (req.body.startsAt !== undefined) set('starts_at', req.body.startsAt);
    if (req.body.endsAt !== undefined) set('ends_at', req.body.endsAt);
    if (req.body.isActive !== undefined) set('is_active', !!req.body.isActive);

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    values.push(campaignId);
    const result = await pool.query(
      `UPDATE sponsor_campaigns SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING id`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// DELETE /participation/admin/sponsor-campaigns/:id — permanently removes
// the campaign and its analytics (sponsor_analytics cascades on delete).
router.delete('/admin/sponsor-campaigns/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const campaignId = asInt(req.params.id);
    if (!campaignId) return res.status(400).json({ error: 'A valid campaign id is required.' });
    const result = await pool.query('DELETE FROM sponsor_campaigns WHERE id = $1 RETURNING id', [campaignId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /participation/admin/sponsor-campaigns/:id/report
router.get('/admin/sponsor-campaigns/:id/report', requireRole('admin'), async (req, res, next) => {
  try {
    const campaignId = asInt(req.params.id);
    if (!campaignId) return res.status(400).json({ error: 'A valid campaign id is required.' });
    const result = await pool.query('SELECT * FROM get_sponsor_campaign_report($1)', [campaignId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found.' });
    res.json({ report: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
