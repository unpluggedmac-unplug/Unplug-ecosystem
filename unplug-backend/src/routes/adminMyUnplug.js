// ADMIN — My Unplug management and analytics (105_my_unplug_profiles.sql).
//
// Two jobs: let an admin find/inspect/moderate a member's community identity,
// and answer "is My Unplug actually being adopted?" from real rows.
//
// Every number here is computed from live tables. Nothing is stored as a
// counter and nothing is seeded with plausible-looking demo figures — an
// analytics screen that invents numbers is worse than one that says zero,
// because zero is actionable and a fabricated 1,284 is not.
//
// Scope note: the brief's analytics document lists many dashboards that need
// systems this project does not have yet (revenue per member, referral
// attribution, fraud scoring). Those are deliberately absent rather than
// stubbed — see the handover notes at the end of this file.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const myUnplugRouter = require('./myUnplug');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /admin/my-unplug/profiles — searchable list, published AND private.
// ---------------------------------------------------------------------------
router.get('/profiles', requireRole('admin'), async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];
    if (req.query.q) {
      values.push(`%${req.query.q}%`);
      conditions.push(`(p.username ILIKE $${values.length} OR p.display_name ILIKE $${values.length} OR u.email ILIKE $${values.length})`);
    }
    if (req.query.status === 'published') conditions.push('p.is_published = true');
    if (req.query.status === 'private') conditions.push('p.is_published = false');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // u.email is included because an admin genuinely needs to identify the
    // account behind a handle. This is an admin-only route behind
    // requireRole — it is the public route that must never join users.
    const result = await pool.query(
      `SELECT p.user_id, p.username, p.display_name, p.about_me, p.avatar_url,
              p.country, p.province, p.city, p.is_published, p.published_at,
              p.created_at, p.updated_at, u.email,
              EXISTS (SELECT 1 FROM profiles d WHERE d.user_id = p.user_id) AS has_directory_listing
         FROM my_unplug_profiles p
         JOIN users u ON u.id = p.user_id
         ${where}
        ORDER BY p.created_at DESC
        LIMIT 500`,
      values
    );
    res.json({ profiles: result.rows });
  } catch (err) { next(err); }
});

// GET /admin/my-unplug/profiles/:userId — one profile in full, including its
// completion breakdown and selections.
router.get('/profiles/:userId', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'A valid user id is required.' });
    const result = await pool.query(
      `SELECT p.*, u.email, u.role,
              EXISTS (SELECT 1 FROM profiles d WHERE d.user_id = p.user_id) AS has_directory_listing
         FROM my_unplug_profiles p JOIN users u ON u.id = p.user_id
        WHERE p.user_id = $1`,
      [userId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'That member has no My Unplug profile.' });
    const taxonomies = await myUnplugRouter.loadTaxonomies(userId);
    res.json({
      profile: result.rows[0],
      taxonomies,
      completion: myUnplugRouter.computeCompletion(result.rows[0], taxonomies),
    });
  } catch (err) { next(err); }
});

// PATCH /admin/my-unplug/profiles/:userId — moderate the free-text fields.
//
// Deliberately limited to display_name, about_me and username: those are the
// fields that can carry abuse or impersonation. An admin has no business
// silently rewriting someone's interests or skills — that is the member's
// own expression, and changing it would misrepresent them.
router.patch('/profiles/:userId', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'A valid user id is required.' });

    const map = { displayName: 'display_name', aboutMe: 'about_me', username: 'username' };
    const sets = [];
    const values = [];
    for (const [bodyKey, column] of Object.entries(map)) {
      if (req.body[bodyKey] !== undefined) {
        values.push(req.body[bodyKey]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    values.push(userId);
    const result = await pool.query(
      `UPDATE my_unplug_profiles SET ${sets.join(', ')}, updated_at = now()
        WHERE user_id = $${values.length} RETURNING *`,
      values
    );
    if (!result.rowCount) return res.status(404).json({ error: 'That member has no My Unplug profile.' });
    logActivity(req.user.id, 'myunplug_profile_edited', `@${result.rows[0].username} (user ${userId})`);
    res.json({ profile: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That @username is already taken.' });
    if (err.code === '23514') return res.status(400).json({ error: 'That @username is not a valid format.' });
    next(err);
  }
});

// POST /admin/my-unplug/profiles/:userId/unpublish — the moderation action.
//
// Preferred over deletion for bad content: it removes the profile from public
// view immediately while leaving the member's data intact, so a wrong call is
// reversible and an appeal has something to look at.
router.post('/profiles/:userId/unpublish', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Give a reason — a moderation action with no stated cause cannot be reviewed later.' });

    const result = await pool.query(
      `UPDATE my_unplug_profiles SET is_published = false, updated_at = now()
        WHERE user_id = $1 RETURNING username`,
      [userId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'That member has no My Unplug profile.' });
    logActivity(req.user.id, 'myunplug_profile_unpublished', `@${result.rows[0].username} — ${reason.slice(0, 300)}`);
    res.json({ unpublished: true, message: `@${result.rows[0].username} is no longer publicly visible.` });
  } catch (err) { next(err); }
});

// DELETE /admin/my-unplug/profiles/:userId — removes the My Unplug profile.
//
// IMPORTANT: this deletes the community identity ONLY. The user account and
// any Directory listing are untouched — they are separate systems, and an
// admin clearing a bad handle must not also destroy someone's paid Directory
// listing or lock them out of their account.
router.delete('/profiles/:userId', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    const result = await pool.query(
      'DELETE FROM my_unplug_profiles WHERE user_id = $1 RETURNING username', [userId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'That member has no My Unplug profile.' });
    logActivity(req.user.id, 'myunplug_profile_deleted', `@${result.rows[0].username} (user ${userId})`);
    res.json({
      deleted: true,
      message: `@${result.rows[0].username}'s My Unplug profile was deleted. Their account and any Directory listing are untouched.`,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /admin/my-unplug/analytics — adoption, completion, taxonomy, geography.
// ---------------------------------------------------------------------------
router.get('/analytics', requireRole('admin'), async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

    const [totals, funnel, completionRows, taxonomy, geography, series] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM my_unplug_profiles) AS total,
           (SELECT COUNT(*)::int FROM my_unplug_profiles WHERE is_published) AS published,
           (SELECT COUNT(*)::int FROM my_unplug_profiles WHERE NOT is_published) AS private,
           (SELECT COUNT(*)::int FROM my_unplug_profiles WHERE created_at >= now() - ($1 || ' days')::interval) AS new_in_window,
           (SELECT COUNT(*)::int FROM users) AS total_users`,
        [String(days)]
      ),
      // The activation funnel: how far members actually get. This is the one
      // that tells you WHERE people drop off, which a headline count cannot.
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM users) AS registered,
           (SELECT COUNT(*)::int FROM my_unplug_profiles) AS profile_started,
           (SELECT COUNT(*)::int FROM my_unplug_profiles WHERE avatar_url IS NOT NULL AND about_me IS NOT NULL) AS profile_filled,
           (SELECT COUNT(DISTINCT user_id)::int FROM mu_profile_interests) AS picked_interests,
           (SELECT COUNT(*)::int FROM my_unplug_profiles WHERE is_published) AS published`
      ),
      // Every profile's fields, so completion can be computed with the SAME
      // rule the member sees rather than a second approximation of it.
      pool.query(
        `SELECT p.user_id, p.username, p.display_name, p.about_me, p.avatar_url,
                EXISTS (SELECT 1 FROM mu_profile_interests x WHERE x.user_id = p.user_id) AS has_interests,
                EXISTS (SELECT 1 FROM mu_profile_skills   x WHERE x.user_id = p.user_id) AS has_skills,
                EXISTS (SELECT 1 FROM mu_profile_purposes x WHERE x.user_id = p.user_id) AS has_purposes
           FROM my_unplug_profiles p`
      ),
      Promise.all([
        pool.query(`SELECT i.label, COUNT(*)::int AS n FROM mu_profile_interests p JOIN mu_interests i ON i.key = p.key GROUP BY i.label ORDER BY n DESC, i.label LIMIT 15`),
        pool.query(`SELECT s.label, COUNT(*)::int AS n FROM mu_profile_skills p JOIN mu_skills s ON s.key = p.key GROUP BY s.label ORDER BY n DESC, s.label LIMIT 15`),
        pool.query(`SELECT u.label, COUNT(*)::int AS n FROM mu_profile_purposes p JOIN mu_purposes u ON u.key = p.key GROUP BY u.label ORDER BY n DESC, u.label LIMIT 15`),
      ]),
      pool.query(
        `SELECT COALESCE(NULLIF(TRIM(province), ''), 'Not given') AS province, COUNT(*)::int AS n
           FROM my_unplug_profiles GROUP BY 1 ORDER BY n DESC, 1 LIMIT 15`
      ),
      pool.query(
        `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
                COUNT(p.user_id)::int AS profiles_created
           FROM generate_series(now() - ($1 || ' days')::interval, now(), interval '1 day') d
           LEFT JOIN my_unplug_profiles p ON p.created_at::date = d::date
          GROUP BY 1 ORDER BY 1`,
        [String(days)]
      ),
    ]);

    // Completion, computed per profile through the shared rule.
    const buckets = { '0-25': 0, '26-50': 0, '51-75': 0, '76-99': 0, '100': 0 };
    const missing = {};
    let completionSum = 0;
    for (const row of completionRows.rows) {
      const tax = {
        interests: row.has_interests ? [1] : [],
        skills: row.has_skills ? [1] : [],
        purposes: row.has_purposes ? [1] : [],
      };
      const c = myUnplugRouter.computeCompletion(row, tax);
      completionSum += c.percent;
      if (c.percent === 100) buckets['100'] += 1;
      else if (c.percent >= 76) buckets['76-99'] += 1;
      else if (c.percent >= 51) buckets['51-75'] += 1;
      else if (c.percent >= 26) buckets['26-50'] += 1;
      else buckets['0-25'] += 1;
      // What people most often leave out — the actionable half of this
      // dashboard, since it says what onboarding should nudge harder.
      c.steps.filter((s) => !s.done).forEach((s) => { missing[s.label] = (missing[s.label] || 0) + 1; });
    }
    const n = completionRows.rows.length;

    const t = totals.rows[0];
    const f = funnel.rows[0];
    const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

    res.json({
      windowDays: days,
      totals: {
        ...t,
        publishedRate: pct(t.published, t.total),
        adoptionRate: pct(t.total, t.total_users), // how many accounts have a My Unplug identity at all
      },
      activationFunnel: [
        { stage: 'Registered', users: f.registered, conversion: 100 },
        { stage: 'Profile started', users: f.profile_started, conversion: pct(f.profile_started, f.registered) },
        { stage: 'Added photo + about', users: f.profile_filled, conversion: pct(f.profile_filled, f.registered) },
        { stage: 'Picked interests', users: f.picked_interests, conversion: pct(f.picked_interests, f.registered) },
        { stage: 'Published', users: f.published, conversion: pct(f.published, f.registered) },
      ],
      completion: {
        average: n ? Math.round((completionSum / n) * 10) / 10 : 0,
        buckets,
        mostCommonlyMissing: Object.entries(missing)
          .map(([label, count]) => ({ label, count }))
          .sort((a, b) => b.count - a.count),
      },
      topInterests: taxonomy[0].rows,
      topSkills: taxonomy[1].rows,
      topPurposes: taxonomy[2].rows,
      byProvince: geography.rows,
      series: series.rows,
    });
  } catch (err) { next(err); }
});

module.exports = router;

// ---------------------------------------------------------------------------
// NOT BUILT, deliberately — each needs a system that does not exist yet, and
// inventing the numbers would make this screen lie:
//
//   * Revenue per member / commercial analytics — needs payments joined to
//     My Unplug identity. The payments tables exist; the link from a payment
//     to a My Unplug profile does not, because payments are keyed to users.
//     Straightforward to add once someone decides that is the right join.
//   * Referral attribution (shares -> visits -> registrations) — needs the
//     frontend to attach a referral code to shared links first.
//   * Trust / fraud risk scoring — trust_scores exists (071) but is driven by
//     the participation engine, not by My Unplug activity; wiring one to the
//     other is its own piece of work.
//   * Retention (D1/D7/D30) — needs a last-seen or session table. Nothing
//     currently records when a member was last active.
// ---------------------------------------------------------------------------
