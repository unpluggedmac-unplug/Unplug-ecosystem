const express = require('express');
const pool = require('../db');
const { requireRole, attachUser } = require('../middleware/auth');
const { contextFrom, COUNTRY_HEADERS } = require('../utils/analyticsContext');
const { recordEvent, touchSession } = require('../utils/analyticsRecorder');

const router = express.Router();

// GET /analytics/public-stats — public, no auth. Real platform totals for
// the homepage Investor Spotlight (replaces the old hardcoded fake numbers
// "12K+ readers / 340+ changemakers / R2M+ tracked").
router.get('/public-stats', async (req, res, next) => {
  try {
    const [views, members, articlesPublished] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT session_id) AS c FROM page_views`),
      pool.query(`SELECT COUNT(*) AS c FROM users`),
      pool.query(`SELECT COUNT(*) AS c FROM articles WHERE status = 'approved'`),
    ]);
    res.json({
      monthlyReaders: Number(views.rows[0].c),
      registeredMembers: Number(members.rows[0].c),
      articlesPublished: Number(articlesPublished.rows[0].c),
    });
  } catch (err) {
    next(err);
  }
});

// POST /analytics/track — public, called once per page view by a small
// snippet on the public site. No login required, no personal data stored
// — session_id is just a random ID the visitor's own browser generates
// (e.g. via localStorage), not tied to any account.
router.post('/track', attachUser, async (req, res, next) => {
  try {
    const { pagePath, sessionId, visitorId } = req.body;
    if (!pagePath) {
      return res.status(400).json({ error: 'pagePath is required.' });
    }

    // The original table still gets its row. Other code reads it and it holds
    // real history — the richer tables below sit alongside it rather than
    // replacing it, so nothing that works today stops working.
    await pool.query(
      `INSERT INTO page_views (page_path, session_id) VALUES ($1, $2)`,
      [pagePath, sessionId || null]
    );

    if (sessionId && visitorId) {
      const context = contextFrom(req, req.body);
      await touchSession({
        sessionId, visitorId, pagePath, context,
        userId: req.user ? req.user.id : null,
        isPageView: true,
      });
      await recordEvent({
        sessionId, visitorId,
        eventName: 'page_view',
        pagePath,
        entityType: req.body.entityType || null,
        entityId: req.body.entityId || null,
        userId: req.user ? req.user.id : null,
      });
    }

    res.status(201).json({ tracked: true });
  } catch (err) {
    next(err);
  }
});

// POST /analytics/event — anything worth counting that is not a page view.
// Conversions that happen in the browser (a newsletter signup, an enquiry
// sent) come through here; conversions the SERVER performs are recorded by
// the server itself, which is the only way to be sure they really happened.
router.post('/event', attachUser, async (req, res, next) => {
  try {
    const eventName = String(req.body.eventName || '').trim();
    if (!eventName) return res.status(400).json({ error: 'eventName is required.' });
    // Free text, but bounded — this is an unauthenticated endpoint and the
    // column is 60 characters.
    if (eventName.length > 60) return res.status(400).json({ error: 'eventName is too long.' });

    const { sessionId, visitorId } = req.body;
    if (sessionId && visitorId) {
      await touchSession({
        sessionId, visitorId,
        pagePath: req.body.pagePath || null,
        context: contextFrom(req, req.body),
        userId: req.user ? req.user.id : null,
        isPageView: false,
      });
    }
    await recordEvent({
      sessionId: sessionId || null,
      visitorId: visitorId || null,
      eventName,
      pagePath: req.body.pagePath || null,
      entityType: req.body.entityType || null,
      entityId: req.body.entityId || null,
      userId: req.user ? req.user.id : null,
      // The tag tapped, or the words typed into search.
      label: req.body.label || null,
      // Never trusted from the browser. Money is only ever recorded by the
      // server, from a real payment row.
      valueCents: null,
    });
    res.status(201).json({ tracked: true });
  } catch (err) {
    next(err);
  }
});

// POST /analytics/identify — binds the anonymous visit to the account that
// just signed in. This is the join that lets "Instagram brought us R2,400"
// exist at all: without it a payment has a user but no idea which visit
// brought that person to the site.
router.post('/identify', attachUser, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Sign-in required.' });
    const { sessionId, visitorId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });

    await pool.query(
      `UPDATE analytics_sessions SET user_id = $1 WHERE session_id = $2 AND user_id IS NULL`,
      [req.user.id, sessionId]
    );
    // Their earlier visits in this browser belong to them too — that is what
    // makes first-touch attribution possible for someone who read for a week
    // before signing up.
    if (visitorId) {
      await pool.query(
        `UPDATE analytics_sessions SET user_id = $1 WHERE visitor_id = $2 AND user_id IS NULL`,
        [req.user.id, visitorId]
      );
    }
    res.json({ identified: true });
  } catch (err) {
    next(err);
  }
});

// GET /analytics/config — public. Tells the site whether a Google Analytics
// property is configured. An empty id means the tag is never loaded at all,
// which is the right state until someone pastes a real one in.
router.get('/config', async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'ga4_measurement_id'`);
    const id = (r.rows[0] && r.rows[0].value || '').trim();
    res.json({ ga4MeasurementId: /^G-[A-Z0-9]+$/i.test(id) ? id : null });
  } catch (err) {
    next(err);
  }
});

// GET /analytics/admin/geo-check — which edge headers actually arrive.
// Whether the country header survives the path from Cloudflare to Render
// cannot be proven from a developer machine, so this reports what the server
// really receives instead of anybody assuming.
router.get('/admin/geo-check', requireRole('admin'), async (req, res, next) => {
  try {
    const present = {};
    COUNTRY_HEADERS.forEach((h) => { if (req.headers[h]) present[h] = req.headers[h]; });
    const stored = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE country IS NOT NULL)::int AS with_country
         FROM analytics_sessions`
    );
    res.json({
      headersPresent: present,
      anyHeaderPresent: Object.keys(present).length > 0,
      sessions: stored.rows[0],
      note: Object.keys(present).length === 0
        ? 'No country header is reaching the server, so country will read Unknown. Nothing else is affected.'
        : 'Country headers are arriving normally.',
    });
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
// Which content type each tracked page belongs to.
//
// page_views.page_path holds the SPA's own page ids ('home', 'news',
// 'directory'), not URLs — plus detail views recorded as '<thing>-<id>'
// ('article-12', 'profile-jane-doe'). Categorising is therefore a mapping over
// those names, which means it works on all the history already recorded rather
// than only on views collected from today.
//
// Order matters: the prefix rules are checked before the exact names so
// 'article-12' is counted as Articles rather than falling through to Other.
const CATEGORY_PREFIXES = [
  ['article-', 'Articles'],
  ['profile-', 'Directory'],
  ['edition-', 'Editions'],
  ['project-', 'Investor Projects'],
];
const CATEGORY_PAGES = {
  home: 'Homepage',
  news: 'Articles',
  article: 'Articles',
  directory: 'Directory',
  directoryprofile: 'Directory',
  gallery: 'Gallery',
  editions: 'Editions',
  top10: 'Top 10',
  competitions: 'Competitions',
  arena: 'Competitions',
  investors: 'Investors',
  investorproject: 'Investor Projects',
  brandplacement: 'Marketplace',
  marketplace: 'Marketplace',
  deafcommunity: 'Deaf Community',
  about: 'About & Info',
  contact: 'About & Info',
  refunds: 'About & Info',
  privacy: 'About & Info',
  terms: 'About & Info',
};

function categoryFor(pagePath) {
  const p = String(pagePath || '').trim();
  for (const [prefix, label] of CATEGORY_PREFIXES) {
    if (p.startsWith(prefix)) return label;
  }
  return CATEGORY_PAGES[p] || 'Other';
}

// GET /analytics/by-category — views grouped by what the page actually is,
// rather than one figure for the whole site. Answers "is the Directory pulling
// its weight against the articles?", which the flat top-pages list cannot.
router.get('/by-category', requireRole('admin'), async (req, res, next) => {
  try {
    const range = [7, 30, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 30;

    // Grouped in JS rather than SQL: the mapping is a product decision that
    // changes as pages are added, and it belongs next to the list above rather
    // than buried in a CASE expression.
    const rows = await pool.query(
      `SELECT page_path, COUNT(*)::int AS views, COUNT(DISTINCT session_id)::int AS visitors
         FROM page_views
        WHERE viewed_at >= now() - ($1::text || ' days')::interval
        GROUP BY page_path`,
      [range]
    );

    const byCategory = new Map();
    for (const r of rows.rows) {
      const label = categoryFor(r.page_path);
      const entry = byCategory.get(label) || { category: label, views: 0, pages: 0, topPages: [] };
      entry.views += r.views;
      entry.pages += 1;
      entry.topPages.push({ path: r.page_path, views: r.views, visitors: r.visitors });
      byCategory.set(label, entry);
    }

    const totalViews = rows.rows.reduce((sum, r) => sum + r.views, 0);
    const categories = [...byCategory.values()]
      .map((c) => ({
        ...c,
        // Share of all tracked views, so a big number can be read in context.
        share: totalViews > 0 ? Math.round((c.views / totalViews) * 1000) / 10 : 0,
        topPages: c.topPages.sort((a, b) => b.views - a.views).slice(0, 5),
      }))
      .sort((a, b) => b.views - a.views);

    res.json({ range, totalViews, categories });
  } catch (err) {
    next(err);
  }
});

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

// GET /analytics/top-article-week — public. Finds the article with the
// most real page views in the last 7 days, using the page_path values
// article detail views record ("article-<id>"). Falls back to the most
// recently published article if there isn't enough view data yet.
router.get('/top-article-week', async (req, res, next) => {
  try {
    const topViewed = await pool.query(
      `SELECT page_path, COUNT(*) AS views
       FROM page_views
       WHERE page_path LIKE 'article-%' AND viewed_at >= now() - interval '7 days'
       GROUP BY page_path
       ORDER BY views DESC
       LIMIT 1`
    );
    if (topViewed.rows.length > 0) {
      const articleId = topViewed.rows[0].page_path.replace('article-', '');
      const articleResult = await pool.query(
        `SELECT id, title FROM articles WHERE id = $1 AND status = 'approved'`,
        [articleId]
      );
      if (articleResult.rows.length > 0) {
        return res.json({ title: articleResult.rows[0].title, basedOn: 'views' });
      }
    }
    // Fallback — not enough view data yet, use most recent article instead.
    const fallback = await pool.query(
      `SELECT title FROM articles WHERE status = 'approved' ORDER BY published_at DESC NULLS LAST, created_at DESC LIMIT 1`
    );
    res.json({ title: fallback.rows[0] ? fallback.rows[0].title : null, basedOn: 'recency' });
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
