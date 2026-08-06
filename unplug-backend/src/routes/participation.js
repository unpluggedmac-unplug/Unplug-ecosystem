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

// GET /participation/business-status-levels — the business status ladder.
router.get('/business-status-levels', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT code, label, emoji, rank_order, min_reviews, min_avg_rating, min_gallery_images, min_days_listed, description FROM business_status_levels ORDER BY rank_order ASC'
    );
    res.json({ statusLevels: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /participation/business-status/:profileId — current status + metrics
// for one Directory listing, so a business's status badge can be shown on
// its public profile page and on its own self-service dashboard. Returns
// null status for non-business profiles or ones not yet promoted, rather
// than 404ing — a listing legitimately has no status until it's approved.
router.get('/business-status/:profileId', async (req, res, next) => {
  try {
    const profileId = asInt(req.params.profileId);
    if (!profileId) return res.status(400).json({ error: 'A valid profileId is required.' });
    const [status, metrics] = await Promise.all([
      pool.query(
        `SELECT sl.code, sl.label, sl.emoji, sl.rank_order, bsh.achieved_at
           FROM business_status_history bsh JOIN business_status_levels sl ON sl.code = bsh.status_code
          WHERE bsh.profile_id = $1 AND bsh.is_active_status = TRUE`,
        [profileId]
      ),
      pool.query('SELECT * FROM get_business_metrics($1)', [profileId]),
    ]);
    res.json({ status: status.rows[0] || null, metrics: metrics.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /participation/discovery — three under-exposed lists (articles,
// members, businesses). Public, read-only, no rotation state — see
// 082_discovery_engine.sql for why each ranking works the way it does.
router.get('/discovery', async (req, res, next) => {
  try {
    const [articles, members, businesses] = await Promise.all([
      pool.query('SELECT * FROM get_discovery_articles(6)'),
      pool.query('SELECT * FROM get_discovery_members(6)'),
      pool.query('SELECT * FROM get_discovery_businesses(6)'),
    ]);
    res.json({ articles: articles.rows, members: members.rows, businesses: businesses.rows });
  } catch (err) {
    next(err);
  }
});

// GET /participation/streak-tiers — the 7 streak milestones.
router.get('/streak-tiers', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT code, label, emoji, min_days, bonus_points, description FROM streak_tiers ORDER BY min_days ASC'
    );
    res.json({ streakTiers: result.rows });
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
    await pool.query('SELECT assign_weekly_mission($1)', [userId]);
    await pool.query('SELECT assign_monthly_challenge($1)', [userId]);

    const [profile, score, statusHistory, statusLevels, streak, streakTiers, achievements, passport, missions, weeklyMission, monthlyChallenge, myRankings, notifications, recognitionCounts] = await Promise.all([
      pool.query('SELECT referral_code, show_on_leaderboard FROM member_participation_profiles WHERE user_id = $1', [userId]),
      pool.query('SELECT * FROM score_cache WHERE user_id = $1', [userId]),
      pool.query(
        `SELECT msh.status_code, sl.label, sl.emoji, sl.rank_order, msh.achieved_at
           FROM member_status_history msh JOIN member_status_levels sl ON sl.code = msh.status_code
          WHERE msh.user_id = $1 AND msh.is_active_status = TRUE`,
        [userId]
      ),
      pool.query('SELECT code, label, emoji, rank_order, min_score, min_days_since_join, min_active_months FROM member_status_levels ORDER BY rank_order ASC'),
      pool.query('SELECT current_streak_days, longest_streak_days, highest_tier_code FROM user_streaks WHERE user_id = $1', [userId]),
      pool.query('SELECT code, label, emoji, min_days, bonus_points FROM streak_tiers ORDER BY min_days ASC'),
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
          WHERE um.user_id = $1 AND m.mission_type = 'daily' AND um.assigned_date = CURRENT_DATE`,
        [userId]
      ),
      pool.query(
        `SELECT um.mission_code, m.title, m.description, m.points_reward, m.target_count, um.progress_count, um.is_completed, um.assigned_date
           FROM user_missions um JOIN missions m ON m.code = um.mission_code
          WHERE um.user_id = $1 AND m.mission_type = 'weekly' AND um.assigned_date = date_trunc('week', CURRENT_DATE)::DATE`,
        [userId]
      ),
      pool.query(
        `SELECT um.mission_code, m.title, m.description, m.points_reward, m.target_count, um.progress_count, um.is_completed, um.assigned_date
           FROM user_missions um JOIN missions m ON m.code = um.mission_code
          WHERE um.user_id = $1 AND m.mission_type = 'challenge' AND um.assigned_date = date_trunc('month', CURRENT_DATE)::DATE`,
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
      streak: streak.rows[0] || { current_streak_days: 0, longest_streak_days: 0, highest_tier_code: null },
      streakTiers: streakTiers.rows,
      achievements: achievements.rows,
      passport: passport.rows,
      todayMissions: missions.rows,
      weeklyMission: weeklyMission.rows[0] || null,
      monthlyChallenge: monthlyChallenge.rows[0] || null,
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

// -- Point values (Stage J) — the rule engine every award_points() call
// reads from. Editing these changes point values site-wide with no
// deploy. No create/delete: every code here is referenced by name from
// application code (award_points() is always called with a specific
// action_code), so adding a new one still requires a code change to
// actually award it — this panel only tunes the numbers on existing ones.

// GET /participation/admin/actions?category=<code> — full list including
// disabled ones, optionally filtered by category for a smaller admin view.
router.get('/admin/actions', requireRole('admin'), async (req, res, next) => {
  try {
    const category = req.query.category;
    const result = await pool.query(
      category
        ? 'SELECT * FROM participation_actions WHERE category_code = $1 ORDER BY code ASC'
        : 'SELECT * FROM participation_actions ORDER BY category_code ASC, code ASC',
      category ? [category] : []
    );
    res.json({ actions: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /participation/admin/actions/:code — partial update.
router.patch('/admin/actions/:code', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

    const b = req.body;
    if (b.basePoints !== undefined) set('base_points', b.basePoints);
    if (b.qualityMultiplierMax !== undefined) set('quality_multiplier_max', b.qualityMultiplierMax);
    if (b.dailyLimit !== undefined) set('daily_limit', b.dailyLimit);
    if (b.weeklyLimit !== undefined) set('weekly_limit', b.weeklyLimit);
    if (b.monthlyLimit !== undefined) set('monthly_limit', b.monthlyLimit);
    if (b.cooldownMinutes !== undefined) set('cooldown_minutes', b.cooldownMinutes);
    if (b.isEnabled !== undefined) set('is_enabled', !!b.isEnabled);
    if (b.notes !== undefined) set('notes', b.notes);

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    values.push(req.params.code);
    const result = await pool.query(
      `UPDATE participation_actions SET ${fields.join(', ')} WHERE code = $${values.length} RETURNING code`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Action not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// -- Member status ladder thresholds -- (business status has its own
// admin/business-status-levels routes, added in Stage I, above this file's
// business-status section)

// GET /participation/admin/status-levels — full member ladder for editing
// (distinct from the public /status-levels route, which returns the same
// columns but is never PATCHed against).
router.get('/admin/status-levels', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM member_status_levels ORDER BY rank_order ASC');
    res.json({ statusLevels: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /participation/admin/status-levels/:code
router.patch('/admin/status-levels/:code', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

    const b = req.body;
    if (b.label !== undefined) set('label', b.label);
    if (b.emoji !== undefined) set('emoji', b.emoji);
    if (b.minScore !== undefined) set('min_score', b.minScore);
    if (b.minDaysSinceJoin !== undefined) set('min_days_since_join', b.minDaysSinceJoin);
    if (b.minActiveMonths !== undefined) set('min_active_months', b.minActiveMonths);
    if (b.description !== undefined) set('description', b.description);

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    values.push(req.params.code);
    const result = await pool.query(
      `UPDATE member_status_levels SET ${fields.join(', ')} WHERE code = $${values.length} RETURNING code`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Status level not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// -- Streak tiers --

// GET /participation/admin/streak-tiers
router.get('/admin/streak-tiers', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM streak_tiers ORDER BY min_days ASC');
    res.json({ streakTiers: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /participation/admin/streak-tiers/:code
router.patch('/admin/streak-tiers/:code', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

    const b = req.body;
    if (b.label !== undefined) set('label', b.label);
    if (b.emoji !== undefined) set('emoji', b.emoji);
    if (b.minDays !== undefined) set('min_days', b.minDays);
    if (b.bonusPoints !== undefined) set('bonus_points', b.bonusPoints);
    if (b.description !== undefined) set('description', b.description);

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    values.push(req.params.code);
    const result = await pool.query(
      `UPDATE streak_tiers SET ${fields.join(', ')} WHERE code = $${values.length} RETURNING code`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Streak tier not found.' });
    res.status(204).end();
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: `Another tier already uses ${req.body.minDays} days — each tier needs a distinct day count.` });
    next(err);
  }
});

// -- Missions (daily + weekly) --

// GET /participation/admin/missions?type=daily|weekly — full list including
// disabled ones (admin needs to see everything, not just what's live).
router.get('/admin/missions', requireRole('admin'), async (req, res, next) => {
  try {
    const type = req.query.type;
    const result = await pool.query(
      type
        ? 'SELECT * FROM missions WHERE mission_type = $1 ORDER BY code ASC'
        : 'SELECT * FROM missions ORDER BY mission_type ASC, code ASC',
      type ? [type] : []
    );
    res.json({ missions: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /participation/admin/missions/weekly-current — this week's active
// mission plus rotation history, for the admin screen to show "what's
// live right now" without the admin having to compute the ISO week
// themselves.
router.get('/admin/missions/weekly-current', requireRole('admin'), async (req, res, next) => {
  try {
    const current = await pool.query('SELECT * FROM get_current_weekly_mission()');
    const history = await pool.query(
      `SELECT wr.week_start, wr.week_end, m.code, m.title
         FROM weekly_mission_rotation wr JOIN missions m ON m.code = wr.mission_code
        ORDER BY wr.week_start DESC LIMIT 12`
    );
    res.json({ current: current.rows[0] || null, history: history.rows });
  } catch (err) {
    next(err);
  }
});

// GET /participation/admin/missions/monthly-current — this month's active
// challenge plus rotation history, same shape/reasoning as the
// weekly-current endpoint above.
router.get('/admin/missions/monthly-current', requireRole('admin'), async (req, res, next) => {
  try {
    const current = await pool.query('SELECT * FROM get_current_monthly_challenge()');
    const history = await pool.query(
      `SELECT mr.month_start, mr.month_end, m.code, m.title
         FROM monthly_challenge_rotation mr JOIN missions m ON m.code = mr.mission_code
        ORDER BY mr.month_start DESC LIMIT 12`
    );
    res.json({ current: current.rows[0] || null, history: history.rows });
  } catch (err) {
    next(err);
  }
});

// POST /participation/admin/missions — body { code, title, description,
// missionType, actionCode?, pointsReward, targetCount, minStatusRank?,
// maxStatusRank? }. actionCode must already exist in participation_actions
// (FK-enforced) — the whole point of Stage A-G's "never seed a mission for
// an action nothing can trigger" rule is that this constraint is real, not
// just a convention, so a typo'd or not-yet-built action_code fails loudly
// here instead of creating a mission nobody can ever complete.
router.post('/admin/missions', requireRole('admin'), async (req, res, next) => {
  try {
    const { code, title, description, missionType, actionCode, pointsReward, targetCount, minStatusRank, maxStatusRank } = req.body;
    if (!code || !title || !description || !missionType) {
      return res.status(400).json({ error: 'code, title, description and missionType are all required.' });
    }
    if (!['daily', 'weekly', 'challenge'].includes(missionType)) {
      return res.status(400).json({ error: 'missionType must be daily, weekly or challenge.' });
    }
    const result = await pool.query(
      `INSERT INTO missions (code, title, description, mission_type, action_code, points_reward, target_count, min_status_rank, max_status_rank)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING code`,
      [code, title, description, missionType, actionCode || null, pointsReward || 0, targetCount || 1, minStatusRank || 0, maxStatusRank != null ? maxStatusRank : 99]
    );
    res.status(201).json({ code: result.rows[0].code });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: `actionCode "${req.body.actionCode}" does not exist — a mission can't reward an action nothing on the site can trigger.` });
    if (err.code === '23505') return res.status(400).json({ error: `A mission with code "${req.body.code}" already exists.` });
    next(err);
  }
});

// PATCH /participation/admin/missions/:code — partial update. Same fields
// as POST, all optional. isEnabled toggles it in/out of daily assignment
// and weekly rotation without deleting its history.
router.patch('/admin/missions/:code', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

    const b = req.body;
    if (b.title !== undefined) set('title', b.title);
    if (b.description !== undefined) set('description', b.description);
    if (b.actionCode !== undefined) set('action_code', b.actionCode);
    if (b.pointsReward !== undefined) set('points_reward', b.pointsReward);
    if (b.targetCount !== undefined) set('target_count', b.targetCount);
    if (b.minStatusRank !== undefined) set('min_status_rank', b.minStatusRank);
    if (b.maxStatusRank !== undefined) set('max_status_rank', b.maxStatusRank);
    if (b.isEnabled !== undefined) set('is_enabled', !!b.isEnabled);

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    values.push(req.params.code);
    const result = await pool.query(
      `UPDATE missions SET ${fields.join(', ')} WHERE code = $${values.length} RETURNING code`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mission not found.' });
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: `actionCode "${req.body.actionCode}" does not exist.` });
    next(err);
  }
});

// GET /participation/admin/business-status-levels — full ladder for the
// admin config screen (same list the public endpoint returns, but this is
// the one PATCHed against, kept separate so the public shape can't be
// accidentally opened up for writes later).
router.get('/admin/business-status-levels', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM business_status_levels ORDER BY rank_order ASC');
    res.json({ statusLevels: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /participation/admin/business-status-levels/:code — edit a tier's
// thresholds. No create/delete: the five tiers are structural (rank order
// matters and gaps would break the "next tier up" query), so admins tune
// the numbers rather than add or remove rungs.
router.patch('/admin/business-status-levels/:code', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

    const b = req.body;
    if (b.label !== undefined) set('label', b.label);
    if (b.emoji !== undefined) set('emoji', b.emoji);
    if (b.minReviews !== undefined) set('min_reviews', b.minReviews);
    if (b.minAvgRating !== undefined) set('min_avg_rating', b.minAvgRating);
    if (b.minGalleryImages !== undefined) set('min_gallery_images', b.minGalleryImages);
    if (b.minDaysListed !== undefined) set('min_days_listed', b.minDaysListed);
    if (b.description !== undefined) set('description', b.description);

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    values.push(req.params.code);
    const result = await pool.query(
      `UPDATE business_status_levels SET ${fields.join(', ')} WHERE code = $${values.length} RETURNING code`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Status level not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /participation/admin/business-status/:profileId/grant — manually
// grant a tier (used for business_hall_of_fame, which requires_admin_approval
// = TRUE and so is never auto-promoted into). Mirrors admin_award_points()'s
// role as the escape hatch for anything the algorithm won't do on its own.
router.post('/admin/business-status/:profileId/grant', requireRole('admin'), async (req, res, next) => {
  try {
    const profileId = asInt(req.params.profileId);
    const { statusCode } = req.body;
    if (!profileId || !statusCode) return res.status(400).json({ error: 'profileId and statusCode are required.' });

    const level = await pool.query('SELECT * FROM business_status_levels WHERE code = $1', [statusCode]);
    if (!level.rows.length) return res.status(400).json({ error: `Unknown status code "${statusCode}".` });
    const owner = await pool.query('SELECT user_id FROM profiles WHERE id = $1 AND type = $2', [profileId, 'business']);
    if (!owner.rows.length) return res.status(404).json({ error: 'Business profile not found.' });

    const metrics = await pool.query('SELECT * FROM get_business_metrics($1)', [profileId]);
    const m = metrics.rows[0];
    await pool.query('UPDATE business_status_history SET is_active_status = FALSE WHERE profile_id = $1 AND is_active_status = TRUE', [profileId]);
    await pool.query(
      `INSERT INTO business_status_history (profile_id, status_code, previous_status, reviews_at_time, avg_rating_at_time, gallery_at_time, days_listed_at_time, granted_by, notes, is_active_status)
       VALUES ($1, $2, (SELECT status_code FROM business_status_history WHERE profile_id = $1 ORDER BY achieved_at DESC LIMIT 1), $3, $4, $5, $6, $7, $8, TRUE)`,
      [profileId, statusCode, m.reviews_count, m.avg_rating, m.gallery_count, m.days_listed, req.user.id, req.body.notes || null]
    );
    if (owner.rows[0].user_id) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body, link_url)
         VALUES ($1, 'status_change', $2, $3, '/unplug-member-dashboard.html')`,
        [owner.rows[0].user_id, `Your business reached ${level.rows[0].emoji} ${level.rows[0].label}!`, `Your Directory listing's standing has levelled up.`]
      );
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

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
