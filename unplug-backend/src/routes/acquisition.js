// Acquisition source, consultant assignment, referral clicks and shares.
//
// Ported from the My Unplug reference package, which modelled the first two
// against a separate `Representative` roster. That roster is, name for name,
// the sales_consultants already here and already driving commission — so
// everything below points at the existing table instead. One roster.
const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole, attachUser } = require('../middleware/auth');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const { logActivity } = require('./activityLog');
const { recordParticipationAsync } = require('../utils/participation');

const router = express.Router();

const SOURCES = ['google', 'facebook', 'instagram', 'linkedin', 'tiktok', 'sales_consultant', 'friend', 'other'];

// GET /acquisition/options — public. What to show in the "how did you hear
// about us?" dropdown, including the live consultant list.
//
// Public and unauthenticated because it is asked before someone has an
// account. Returns id and name only — never commission rates, never how many
// members a consultant has.
router.get('/options', async (req, res, next) => {
  try {
    const consultants = await pool.query(
      'SELECT id, name FROM sales_consultants WHERE active = true ORDER BY name'
    );
    res.json({
      sources: [
        { key: 'google', label: 'Google search' },
        { key: 'facebook', label: 'Facebook' },
        { key: 'instagram', label: 'Instagram' },
        { key: 'linkedin', label: 'LinkedIn' },
        { key: 'tiktok', label: 'TikTok' },
        { key: 'sales_consultant', label: 'An Unplug consultant' },
        { key: 'friend', label: 'A friend or colleague' },
        { key: 'other', label: 'Somewhere else' },
      ],
      consultants: consultants.rows,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /acquisition/me — the signed-in member records how they heard about us.
//
// Separate from registration on purpose: registration already exists, is
// already tested, and is the one flow on the site that absolutely must not
// break. This can be called straight after signup, or later from the
// dashboard, without touching that code path.
//
// Write-once by default. The answer decides who earns commission on this
// member's payments, so letting it be edited freely would let someone
// redirect commission at will. An admin can still override via assignment.
router.put('/me', requireAuth, async (req, res, next) => {
  try {
    const source = String(req.body.source || '').trim();
    if (!SOURCES.includes(source)) {
      return res.status(400).json({ error: 'Choose one of the listed options.' });
    }
    let consultantId = null;
    let otherText = null;

    if (source === 'sales_consultant') {
      consultantId = Number(req.body.consultantId);
      if (!Number.isInteger(consultantId) || consultantId <= 0) {
        return res.status(400).json({ error: 'Choose which consultant told you about Unplug.' });
      }
      const c = await pool.query('SELECT id FROM sales_consultants WHERE id = $1 AND active = true', [consultantId]);
      if (c.rows.length === 0) return res.status(400).json({ error: 'That is not a current Unplug consultant.' });
    }
    if (source === 'other') {
      otherText = String(req.body.otherText || '').trim().slice(0, 200) || null;
    }

    const existing = await pool.query('SELECT acquisition_source FROM users WHERE id = $1', [req.user.id]);
    if (existing.rows[0] && existing.rows[0].acquisition_source) {
      return res.status(409).json({
        error: 'You have already told us how you heard about Unplug. Contact us if it needs changing.',
      });
    }

    await pool.query(
      `UPDATE users
          SET acquisition_source = $2, acquisition_consultant_id = $3,
              acquisition_other_text = $4, acquisition_recorded_at = now()
        WHERE id = $1`,
      [req.user.id, source, consultantId, otherText]
    );

    res.json({ saved: true, message: 'Thank you — that helps us know what is working.' });
  } catch (err) {
    next(err);
  }
});

// GET /acquisition/me — what this member answered, and who currently earns
// commission on their payments. Shown back to them so it is not a black box.
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT u.acquisition_source, u.acquisition_other_text, u.acquisition_recorded_at,
              ac.name AS acquisition_consultant_name,
              asg.name AS assigned_consultant_name
         FROM users u
         LEFT JOIN sales_consultants ac ON ac.id = u.acquisition_consultant_id
         LEFT JOIN sales_consultants asg ON asg.id = u.assigned_consultant_id
        WHERE u.id = $1`,
      [req.user.id]
    );
    res.json({ acquisition: r.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// ADMIN — assigning a member to a consultant.
//
// This MOVES MONEY: an assignment outranks what the member said at signup, so
// from the next payment onward the assigned consultant earns the commission.
// Every change is therefore written to consultant_assignment_history with who
// did it and why, and nothing already recorded is re-attributed.
// ---------------------------------------------------------------------------

// GET /acquisition/admin/members?q=&consultantId=&unassigned=1
router.get('/admin/members', requireRole('admin'), async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];
    if (req.query.q) {
      values.push(`%${req.query.q}%`);
      conditions.push(`(u.email ILIKE $${values.length} OR u.full_name ILIKE $${values.length})`);
    }
    if (req.query.consultantId) {
      values.push(Number(req.query.consultantId));
      conditions.push(`u.assigned_consultant_id = $${values.length}`);
    }
    if (req.query.unassigned === '1') conditions.push('u.assigned_consultant_id IS NULL');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.acquisition_source, u.acquisition_other_text,
              ac.id AS acquisition_consultant_id, ac.name AS acquisition_consultant_name,
              asg.id AS assigned_consultant_id, asg.name AS assigned_consultant_name,
              u.assigned_at
         FROM users u
         LEFT JOIN sales_consultants ac ON ac.id = u.acquisition_consultant_id
         LEFT JOIN sales_consultants asg ON asg.id = u.assigned_consultant_id
         ${where}
        ORDER BY u.id DESC
        LIMIT 300`,
      values
    );
    // Spelled out per row so the admin can see WHO would be credited by the
    // next payment without working the precedence out in their head.
    res.json({
      members: result.rows.map((m) => ({
        ...m,
        commissionOwner: m.assigned_consultant_name || m.acquisition_consultant_name || null,
        commissionSource: m.assigned_consultant_name ? 'admin_assignment'
          : (m.acquisition_consultant_name ? 'member_signup' : 'checkout_selection'),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /acquisition/admin/assign/:userId { consultantId | null, reason }
router.post('/admin/assign/:userId', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.userId);
    const raw = req.body.consultantId;
    const consultantId = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    const reason = String(req.body.reason || '').trim();

    await client.query('BEGIN');

    const user = await client.query(
      'SELECT id, email, assigned_consultant_id FROM users WHERE id = $1 FOR UPDATE', [userId]
    );
    if (user.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That member no longer exists.' });
    }
    const previous = user.rows[0].assigned_consultant_id;

    let consultantName = null;
    if (consultantId !== null) {
      if (!Number.isInteger(consultantId) || consultantId <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Choose a consultant, or clear the assignment.' });
      }
      const c = await client.query('SELECT id, name, active FROM sales_consultants WHERE id = $1', [consultantId]);
      if (c.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'That consultant record no longer exists.' });
      }
      // Assigning to someone switched off would accrue commission to a person
      // who has most likely left.
      if (!c.rows[0].active) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `${c.rows[0].name} is not an active consultant, so they cannot be assigned members.` });
      }
      consultantName = c.rows[0].name;
    }

    if (previous === consultantId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That member is already assigned exactly like that.' });
    }

    // $2 is cast explicitly: used bare on both sides of a CASE, Postgres
    // cannot infer the type of a parameter that may be NULL and rejects the
    // whole statement with "could not determine data type of parameter $2".
    await client.query(
      `UPDATE users SET assigned_consultant_id = $2::integer,
              assigned_at = CASE WHEN $2::integer IS NULL THEN NULL ELSE now() END,
              assigned_by = $3
        WHERE id = $1`,
      [userId, consultantId, req.user.id]
    );
    await client.query(
      `INSERT INTO consultant_assignment_history (user_id, from_consultant_id, to_consultant_id, admin_user_id, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, previous, consultantId, req.user.id, reason || null]
    );
    await client.query('COMMIT');

    await logActivity(req.user.id, consultantId === null ? 'consultant_assignment_cleared' : 'consultant_assigned',
      `${consultantId === null ? 'Cleared the consultant assignment for' : `Assigned ${consultantName} to`} ${user.rows[0].email}`
      + ` (was consultant #${previous || 'none'})${reason ? '. Reason: ' + reason : ''}`
      + '. Applies to their future payments only.').catch(() => {});

    res.json({
      assigned: consultantId !== null,
      message: consultantId === null
        ? 'Assignment cleared. Commission falls back to what the member chose at signup.'
        : `${consultantName} will earn commission on this member's future payments. Payments already recorded are unchanged.`,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// GET /acquisition/admin/assign/:userId/history
router.get('/admin/assign/:userId/history', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT h.id, h.created_at, h.reason,
              f.name AS from_name, t.name AS to_name, a.email AS admin_email
         FROM consultant_assignment_history h
         LEFT JOIN sales_consultants f ON f.id = h.from_consultant_id
         LEFT JOIN sales_consultants t ON t.id = h.to_consultant_id
         LEFT JOIN users a ON a.id = h.admin_user_id
        WHERE h.user_id = $1
        ORDER BY h.created_at DESC, h.id DESC
        LIMIT 100`,
      [Number(req.params.userId)]
    );
    res.json({ history: r.rows });
  } catch (err) {
    next(err);
  }
});

// GET /acquisition/admin/analytics — where members actually come from, and
// what each consultant is carrying.
router.get('/admin/analytics', requireRole('admin'), async (req, res, next) => {
  try {
    const bySource = await pool.query(
      `SELECT COALESCE(acquisition_source, 'not_answered') AS source, COUNT(*)::int AS members
         FROM users GROUP BY 1 ORDER BY members DESC`
    );
    const byConsultant = await pool.query(
      `SELECT c.id, c.name, c.active,
              COUNT(DISTINCT sign.id)::int AS signups_credited,
              COUNT(DISTINCT asg.id)::int AS members_assigned
         FROM sales_consultants c
         LEFT JOIN users sign ON sign.acquisition_consultant_id = c.id
         LEFT JOIN users asg ON asg.assigned_consultant_id = c.id
        GROUP BY c.id, c.name, c.active
        ORDER BY members_assigned DESC, signups_credited DESC`
    );
    // Where commission actually landed, which is the number that matters when
    // a consultant asks why their payout looks the way it does.
    const byAttribution = await pool.query(
      `SELECT COALESCE(consultant_source, 'none') AS source, COUNT(*)::int AS payments,
              COALESCE(SUM(amount), 0)::numeric AS total
         FROM payments WHERE status = 'confirmed' GROUP BY 1 ORDER BY payments DESC`
    );
    res.json({
      bySource: bySource.rows,
      byConsultant: byConsultant.rows,
      byAttribution: byAttribution.rows.map((r) => ({ ...r, total: Number(r.total) })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// REFERRAL CLICKS — the half of referrals that never converted.
// ---------------------------------------------------------------------------

// POST /acquisition/referral-clicks { code } — public, rate limited.
router.post('/referral-clicks', publicSubmitLimiter, attachUser, async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim().slice(0, 20);
    if (!code) return res.status(400).json({ error: 'A referral code is required.' });

    const owner = await pool.query(
      'SELECT user_id FROM member_participation_profiles WHERE referral_code = $1', [code]
    );

    await pool.query(
      `INSERT INTO referral_clicks (referral_code, referrer_user_id, user_agent, referrer_url)
       VALUES ($1, $2, $3, $4)`,
      [
        code,
        owner.rows[0] ? owner.rows[0].user_id : null,
        (req.get('user-agent') || '').slice(0, 200) || null,
        String(req.body.from || '').slice(0, 300) || null,
      ]
    );
    // Always 200, even for a code that matches nothing: this is a public
    // endpoint, and a different answer for real and fake codes would turn it
    // into a way to enumerate members' referral codes.
    res.json({ recorded: true });
  } catch (err) {
    next(err);
  }
});

// GET /acquisition/referral-clicks/mine — a member's own funnel.
router.get('/referral-clicks/mine', requireAuth, async (req, res, next) => {
  try {
    const clicks = await pool.query(
      `SELECT COUNT(*)::int AS clicks,
              COUNT(*) FILTER (WHERE converted_user_id IS NOT NULL)::int AS converted
         FROM referral_clicks WHERE referrer_user_id = $1`,
      [req.user.id]
    );
    const signups = await pool.query(
      'SELECT COUNT(*)::int AS n FROM member_referrals WHERE referrer_user_id = $1', [req.user.id]
    );
    const c = clicks.rows[0];
    res.json({
      clicks: c.clicks,
      signups: signups.rows[0].n,
      // Guarded: a member with no clicks yet must read 0%, not NaN.
      conversionRate: c.clicks > 0 ? Number(((signups.rows[0].n / c.clicks) * 100).toFixed(1)) : 0,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// SHARES
// ---------------------------------------------------------------------------

const SHARE_TYPES = ['achievement', 'badge', 'status', 'ranking', 'competition', 'profile', 'passport', 'article', 'edition'];

// POST /acquisition/shares { shareType, entityId, channel }
router.post('/shares', attachUser, publicSubmitLimiter, async (req, res, next) => {
  try {
    const shareType = String(req.body.shareType || '').trim();
    if (!SHARE_TYPES.includes(shareType)) {
      return res.status(400).json({ error: 'Unknown share type.' });
    }
    await pool.query(
      `INSERT INTO share_events (user_id, share_type, entity_id, channel) VALUES ($1, $2, $3, $4)`,
      [
        req.user ? req.user.id : null, shareType,
        Number.isInteger(Number(req.body.entityId)) ? Number(req.body.entityId) : null,
        String(req.body.channel || '').trim().slice(0, 30) || null,
      ]
    );
    // Only a signed-in sharer can be credited; anonymous shares are still
    // recorded above for the analytics, they just earn nobody anything.
    if (req.user) {
      recordParticipationAsync(req.user.id, 'content_share', {
        contentType: shareType,
        contentId: Number.isInteger(Number(req.body.entityId)) ? Number(req.body.entityId) : null,
      });
    }
    res.json({ recorded: true });
  } catch (err) {
    next(err);
  }
});

// GET /acquisition/admin/shares — what gets shared, and where to.
router.get('/admin/shares', requireRole('admin'), async (req, res, next) => {
  try {
    const byType = await pool.query(
      `SELECT share_type, COUNT(*)::int AS shares FROM share_events GROUP BY 1 ORDER BY shares DESC`
    );
    const byChannel = await pool.query(
      `SELECT COALESCE(channel, 'unknown') AS channel, COUNT(*)::int AS shares
         FROM share_events GROUP BY 1 ORDER BY shares DESC`
    );
    const total = await pool.query('SELECT COUNT(*)::int AS n FROM share_events');
    res.json({ total: total.rows[0].n, byType: byType.rows, byChannel: byChannel.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
