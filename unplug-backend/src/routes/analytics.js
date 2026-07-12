const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// POST /analytics/track — public, called once per page view by a small
// snippet on the public site. No login required, no personal data stored
// — session_id is just a random ID the visitor's own browser generates
// (e.g. via localStorage), not tied to any account.
router.post('/track', async (req, res, next) => {
  try {
    const { pagePath, sessionId } = req.body;
    if (!pagePath) {
      return res.status(400).json({ error: 'pagePath is required.' });
    }
    await pool.query(
      `INSERT INTO page_views (page_path, session_id) VALUES ($1, $2)`,
      [pagePath, sessionId || null]
    );
    res.status(201).json({ tracked: true });
  } catch (err) {
    next(err);
  }
});

// GET /analytics/live-visitors — public. Counts distinct visitor sessions
// seen in the last 5 minutes, for the homepage "X people here right now" stat.
router.get('/live-visitors', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(DISTINCT session_id) AS live_count
       FROM page_views
       WHERE viewed_at >= now() - interval '5 minutes'`
    );
    res.json({ liveVisitors: Number(result.rows[0].live_count) });
  } catch (err) {
    next(err);
  }
});

// GET /analytics/summary?range=7|30|90 — admin-only. Total views, unique
// visitors (by session_id), pages tracked, a daily breakdown for the
// chart, and the top pages — everything the Site Analytics screen needs
// in one call.
router.get('/summary', requireRole('admin'), async (req, res, next) => {
  try {
    const range = [7, 30, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 30;

    const totals = await pool.query(
      `SELECT COUNT(*) AS total_views, COUNT(DISTINCT session_id) AS unique_visitors, COUNT(DISTINCT page_path) AS pages_tracked
       FROM page_views
       WHERE viewed_at >= now() - ($1::text || ' days')::interval`,
      [range]
    );

    const daily = await pool.query(
      `SELECT DATE(viewed_at) AS day, COUNT(*) AS views
       FROM page_views
       WHERE viewed_at >= now() - ($1::text || ' days')::interval
       GROUP BY DATE(viewed_at)
       ORDER BY day ASC`,
      [range]
    );

    const topPages = await pool.query(
      `SELECT page_path, COUNT(*) AS views
       FROM page_views
       WHERE viewed_at >= now() - ($1::text || ' days')::interval
       GROUP BY page_path
       ORDER BY views DESC
       LIMIT 10`,
      [range]
    );

    res.json({
      range,
      totalViews: Number(totals.rows[0].total_views),
      uniqueVisitors: Number(totals.rows[0].unique_visitors),
      pagesTracked: Number(totals.rows[0].pages_tracked),
      daily: daily.rows.map((r) => ({ day: r.day, views: Number(r.views) })),
      topPages: topPages.rows.map((r) => ({ path: r.page_path, views: Number(r.views) })),
    });
  } catch (err) {
    next(err);
  }
});

// TEMPORARY — confirms which database this backend is actually talking
// to. Safe to delete once the Railway/Supabase database mismatch
// question is resolved.
router.get('/db-check', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT current_database(), current_schema(), current_user;');
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
