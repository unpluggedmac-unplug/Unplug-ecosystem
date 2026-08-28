// THE REPORTS. Everything the admin Analytics screen reads.
//
// Split out of analytics.js, which is the WRITE path plus a few small public
// counters. These are all admin-only reads over a date range, and keeping them
// apart means the endpoint written to on every single page load is not in the
// same file as a dozen reporting queries.
//
// Every report takes the same ?from=&to= window and every one of them is
// bounded by it, so no query here can walk the whole table as it grows.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// A window, always. Defaults to the last 30 days; capped at two years so a
// mistyped date cannot ask for a full table scan.
// A DEFAULT `to` MEANS "UP TO NOW, INCLUSIVE" — and has to be given a moment's
// lead to actually mean it.
//
// Postgres timestamps carry microseconds; a JavaScript Date carries only
// milliseconds. An event written at 28.171889 is 889 microseconds AFTER a `to`
// of 28.171, so a report requested in the same millisecond as a payment leaves
// that payment out of its own window. Reporting windows are normally days
// wide, which is why this stayed hidden: it only shows when the write and the
// read land microseconds apart, which is exactly what a test does.
//
// A second of lead costs nothing — no event is ever recorded in the future —
// and removes the truncation race outright. An explicitly supplied `to` is
// left exactly as asked for: somebody who names an end time means it.
function windowFrom(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 1000);
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 864e5);
  const safeTo = isNaN(to) ? new Date(Date.now() + 1000) : to;
  const safeFrom = isNaN(from) ? new Date(Date.now() - 30 * 864e5) : from;
  const earliest = new Date(safeTo.getTime() - 730 * 864e5);
  return { from: safeFrom < earliest ? earliest : safeFrom, to: safeTo };
}

const limitFrom = (req, fallback = 20) =>
  Math.min(Math.max(parseInt(req.query.limit, 10) || fallback, 1), 200);

// GET /analytics-reports/overview — the headline numbers plus a daily series.
router.get('/overview', requireRole('admin'), async (req, res, next) => {
  try {
    const { from, to } = windowFrom(req);

    const totals = await pool.query(
      `SELECT COUNT(*)::int                                             AS sessions,
              COUNT(DISTINCT visitor_id)::int                           AS visitors,
              COUNT(*) FILTER (WHERE is_returning)::int                 AS returning_sessions,
              COUNT(*) FILTER (WHERE NOT is_returning)::int             AS new_sessions,
              COALESCE(SUM(page_count), 0)::int                         AS page_views,
              -- A visit that never went past its first page. The single most
              -- quoted engagement number, and meaningless without the window.
              COUNT(*) FILTER (WHERE page_count <= 1)::int              AS single_page_sessions,
              COALESCE(ROUND(AVG(page_count)::numeric, 2), 0)           AS pages_per_session,
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (last_seen_at - started_at)))::numeric, 0), 0) AS avg_seconds
         FROM analytics_sessions
        WHERE started_at BETWEEN $1 AND $2`,
      [from, to]
    );

    const daily = await pool.query(
      `SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS sessions,
              COUNT(DISTINCT visitor_id)::int AS visitors,
              COALESCE(SUM(page_count), 0)::int AS page_views
         FROM analytics_sessions
        WHERE started_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 1`,
      [from, to]
    );

    res.json({ window: { from, to }, totals: totals.rows[0], daily: daily.rows });
  } catch (err) {
    next(err);
  }
});

// GET /analytics-reports/sources — where the visits came from.
router.get('/sources', requireRole('admin'), async (req, res, next) => {
  try {
    const { from, to } = windowFrom(req);

    const sources = await pool.query(
      `SELECT COALESCE(source, 'Unknown') AS source,
              COUNT(*)::int AS sessions,
              COUNT(DISTINCT visitor_id)::int AS visitors,
              COALESCE(SUM(page_count), 0)::int AS page_views,
              COUNT(*) FILTER (WHERE page_count > 1)::int AS engaged_sessions
         FROM analytics_sessions
        WHERE started_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY sessions DESC`,
      [from, to]
    );

    // The individual sites behind the "Referral" bucket. Without this, "other
    // websites" is a number nobody can act on.
    const referrers = await pool.query(
      `SELECT referrer_host, COUNT(*)::int AS sessions
         FROM analytics_sessions
        WHERE started_at BETWEEN $1 AND $2 AND referrer_host IS NOT NULL
        GROUP BY 1 ORDER BY sessions DESC LIMIT $3`,
      [from, to, limitFrom(req)]
    );

    const campaigns = await pool.query(
      `SELECT campaign, COALESCE(source, 'Unknown') AS source, COUNT(*)::int AS sessions
         FROM analytics_sessions
        WHERE started_at BETWEEN $1 AND $2 AND campaign IS NOT NULL
        GROUP BY 1, 2 ORDER BY sessions DESC LIMIT $3`,
      [from, to, limitFrom(req)]
    );

    res.json({ window: { from, to }, sources: sources.rows, referrers: referrers.rows, campaigns: campaigns.rows });
  } catch (err) {
    next(err);
  }
});

// GET /analytics-reports/content — what people actually read.
router.get('/content', requireRole('admin'), async (req, res, next) => {
  try {
    const { from, to } = windowFrom(req);
    const limit = limitFrom(req);

    const pages = await pool.query(
      `SELECT page_path,
              COUNT(*)::int AS views,
              COUNT(DISTINCT session_id)::int AS sessions
         FROM analytics_events
        WHERE event_name = 'page_view' AND occurred_at BETWEEN $1 AND $2
          AND page_path IS NOT NULL
        GROUP BY 1 ORDER BY views DESC LIMIT $3`,
      [from, to, limit]
    );

    // Articles by name rather than by path, because a path with an id in it is
    // not something anyone can read a report from.
    const articles = await pool.query(
      `SELECT e.entity_id AS article_id, a.title,
              COUNT(*)::int AS views,
              COUNT(DISTINCT e.session_id)::int AS sessions
         FROM analytics_events e
         JOIN articles a ON a.id = e.entity_id
        WHERE e.event_name = 'page_view' AND e.entity_type = 'article'
          AND e.occurred_at BETWEEN $1 AND $2
        GROUP BY 1, 2 ORDER BY views DESC LIMIT $3`,
      [from, to, limit]
    );

    const entry = await pool.query(
      `SELECT entry_path AS page_path, COUNT(*)::int AS sessions
         FROM analytics_sessions
        WHERE started_at BETWEEN $1 AND $2 AND entry_path IS NOT NULL
        GROUP BY 1 ORDER BY sessions DESC LIMIT $3`,
      [from, to, limit]
    );

    const exit = await pool.query(
      `SELECT exit_path AS page_path, COUNT(*)::int AS sessions
         FROM analytics_sessions
        WHERE started_at BETWEEN $1 AND $2 AND exit_path IS NOT NULL
        GROUP BY 1 ORDER BY sessions DESC LIMIT $3`,
      [from, to, limit]
    );

    res.json({ window: { from, to }, pages: pages.rows, articles: articles.rows, entryPages: entry.rows, exitPages: exit.rows });
  } catch (err) {
    next(err);
  }
});

// GET /analytics-reports/audience — device, browser, system, country,
// and how much of the audience is coming back.
router.get('/audience', requireRole('admin'), async (req, res, next) => {
  try {
    const { from, to } = windowFrom(req);

    const group = async (column) => (await pool.query(
      `SELECT COALESCE(${column}, 'Unknown') AS label,
              COUNT(*)::int AS sessions,
              COUNT(DISTINCT visitor_id)::int AS visitors
         FROM analytics_sessions
        WHERE started_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY sessions DESC`,
      [from, to]
    )).rows;

    const [devices, browsers, systems, countries] = await Promise.all([
      group('device_type'), group('browser'), group('os'), group('country'),
    ]);

    // How often people come back, counted per visitor rather than per visit —
    // "how loyal is the audience", not "how busy was the site".
    const loyalty = await pool.query(
      `SELECT CASE WHEN visits = 1 THEN '1 visit'
                   WHEN visits BETWEEN 2 AND 3 THEN '2-3 visits'
                   WHEN visits BETWEEN 4 AND 9 THEN '4-9 visits'
                   ELSE '10+ visits' END AS label,
              COUNT(*)::int AS visitors
         FROM (SELECT visitor_id, COUNT(*)::int AS visits
                 FROM analytics_sessions
                WHERE started_at BETWEEN $1 AND $2
                GROUP BY visitor_id) t
        GROUP BY 1
        ORDER BY MIN(visits)`,
      [from, to]
    );

    res.json({ window: { from, to }, devices, browsers, systems, countries, loyalty: loyalty.rows });
  } catch (err) {
    next(err);
  }
});

// GET /analytics-reports/funnel — visitors to leads to customers to revenue.
//
// THE PART GOOGLE ANALYTICS CANNOT DO, because the money is in this database
// and not in theirs.
//
// Attribution is FIRST TOUCH: a paying customer is credited to the visit that
// first brought them to the site, not the one they happened to pay on. Someone
// who found Unplug through Instagram, read for two weeks and then came back by
// typing the address in was won by Instagram — last-touch would credit that to
// "Direct" and make every channel look like it does nothing.
router.get('/funnel', requireRole('admin'), async (req, res, next) => {
  try {
    const { from, to } = windowFrom(req);

    const LEAD_EVENTS = ['signup', 'newsletter_signup', 'enquiry', 'article_submitted',
      'listing_submitted', 'competition_entered'];

    const steps = await pool.query(
      `SELECT
         (SELECT COUNT(DISTINCT visitor_id)::int FROM analytics_sessions
           WHERE started_at BETWEEN $1 AND $2)                              AS visitors,
         (SELECT COUNT(DISTINCT COALESCE(user_id::text, visitor_id))::int
            FROM analytics_events
           WHERE occurred_at BETWEEN $1 AND $2 AND event_name = ANY($3))    AS leads,
         (SELECT COUNT(DISTINCT user_id)::int FROM analytics_events
           WHERE occurred_at BETWEEN $1 AND $2 AND event_name = 'payment'
             AND user_id IS NOT NULL)                                       AS customers,
         (SELECT COALESCE(SUM(value_cents), 0)::bigint FROM analytics_events
           WHERE occurred_at BETWEEN $1 AND $2 AND event_name = 'payment')  AS revenue_cents`,
      [from, to, LEAD_EVENTS]
    );

    const byEvent = await pool.query(
      `SELECT event_name, COUNT(*)::int AS count,
              COUNT(DISTINCT COALESCE(user_id::text, visitor_id))::int AS people,
              COALESCE(SUM(value_cents), 0)::bigint AS value_cents
         FROM analytics_events
        WHERE occurred_at BETWEEN $1 AND $2 AND event_name <> 'page_view'
        GROUP BY 1 ORDER BY count DESC`,
      [from, to]
    );

    // Revenue traced back to the channel that first brought the customer.
    const bySource = await pool.query(
      `WITH first_touch AS (
         SELECT DISTINCT ON (user_id) user_id, source
           FROM analytics_sessions
          WHERE user_id IS NOT NULL
          ORDER BY user_id, started_at ASC
       )
       SELECT COALESCE(ft.source, 'Unattributed') AS source,
              COUNT(DISTINCT e.user_id)::int      AS customers,
              COALESCE(SUM(e.value_cents), 0)::bigint AS revenue_cents
         FROM analytics_events e
         LEFT JOIN first_touch ft ON ft.user_id = e.user_id
        WHERE e.event_name = 'payment' AND e.occurred_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY revenue_cents DESC`,
      [from, to]
    );

    const t = steps.rows[0];
    res.json({
      window: { from, to },
      funnel: {
        visitors: t.visitors,
        leads: t.leads,
        customers: t.customers,
        revenueCents: Number(t.revenue_cents),
        // Given plainly so nobody has to recompute them from the raw counts.
        visitorToLeadPct: t.visitors ? Math.round((t.leads / t.visitors) * 1000) / 10 : 0,
        leadToCustomerPct: t.leads ? Math.round((t.customers / t.leads) * 1000) / 10 : 0,
      },
      byEvent: byEvent.rows.map((r) => ({ ...r, value_cents: Number(r.value_cents) })),
      bySource: bySource.rows.map((r) => ({ ...r, revenue_cents: Number(r.revenue_cents) })),
      leadEvents: LEAD_EVENTS,
    });
  } catch (err) {
    next(err);
  }
});

// GET /analytics-reports/topics — what subjects people actually read, tap and
// search for, and which of them bring paying customers.
//
// TWO DIMENSIONS, and they are not equally trustworthy.
//   category — chosen by a person for every article. Reliable from day one, so
//     "Health & Wellness outperforms Motoring" is a finding you can commission
//     against.
//   tag — derived from word frequency unless an editor has rewritten it. Finer
//     grained and genuinely useful, but early numbers describe the extraction
//     as much as the readers. The report returns both rather than pretending
//     they carry the same weight.
//
// THREE SIGNALS, in ascending order of what they tell you:
//   a read  — attention, derived from page views already being captured
//   a tap   — a reader asking for MORE of this subject
//   a search — what somebody wanted, including when we did not have it
router.get('/topics', requireRole('admin'), async (req, res, next) => {
  try {
    const { from, to } = windowFrom(req);
    const limit = limitFrom(req);

    // Reads by curated category.
    const categories = await pool.query(
      `SELECT c.name AS label,
              COUNT(*)::int AS reads,
              COUNT(DISTINCT e.session_id)::int AS sessions,
              COUNT(DISTINCT e.entity_id)::int AS articles
         FROM analytics_events e
         JOIN articles a ON a.id = e.entity_id
         JOIN categories c ON c.id = a.category_id
        WHERE e.event_name = 'page_view' AND e.entity_type = 'article'
          AND e.occurred_at BETWEEN $1 AND $2
        GROUP BY c.name
        ORDER BY reads DESC`,
      [from, to]
    );

    // Reads by tag. unnest because articles.tags is an array, and a piece
    // carrying five tags is genuinely a read of all five subjects.
    const tagReads = await pool.query(
      `SELECT t.tag AS label,
              COUNT(*)::int AS reads,
              COUNT(DISTINCT e.session_id)::int AS sessions
         FROM analytics_events e
         JOIN articles a ON a.id = e.entity_id
         CROSS JOIN LATERAL unnest(a.tags) AS t(tag)
        WHERE e.event_name = 'page_view' AND e.entity_type = 'article'
          AND e.occurred_at BETWEEN $1 AND $2
          AND a.tags IS NOT NULL
        GROUP BY t.tag
        ORDER BY reads DESC
        LIMIT $3`,
      [from, to, limit]
    );

    // Taps on a topic chip. A far stronger signal than a read — the reader is
    // asking for more of this — so it is reported alongside rather than added
    // into the read count, where its small numbers would vanish.
    const tagTaps = await pool.query(
      `SELECT label, COUNT(*)::int AS taps,
              COUNT(DISTINCT COALESCE(visitor_id, session_id))::int AS people
         FROM analytics_events
        WHERE event_name = 'topic_click' AND label IS NOT NULL
          AND occurred_at BETWEEN $1 AND $2
        GROUP BY label ORDER BY taps DESC LIMIT $3`,
      [from, to, limit]
    );

    // What people typed. The empty ones matter most: a search that found
    // nothing is a subject the audience wanted and the publication does not
    // cover, which is the one thing traffic figures can never tell you.
    const searches = await pool.query(
      `SELECT label,
              COUNT(*) FILTER (WHERE event_name = 'site_search')::int AS searches,
              COUNT(*) FILTER (WHERE event_name = 'site_search_empty')::int AS found_nothing
         FROM analytics_events
        WHERE event_name IN ('site_search', 'site_search_empty')
          AND label IS NOT NULL AND occurred_at BETWEEN $1 AND $2
        GROUP BY label ORDER BY searches DESC LIMIT $3`,
      [from, to, limit]
    );

    // REVENUE BY SUBJECT.
    //
    // Credited to the FIRST article topic a customer read, matching how source
    // attribution already works. Splitting revenue across every category they
    // ever read would inflate the totals past what was actually earned, and
    // crediting the last one before paying would hand every sale to whatever
    // they happened to be reading at the time.
    //
    // A customer who paid without ever reading an article is 'No article read'
    // rather than dropped, so the columns still sum to real revenue.
    const revenue = await pool.query(
      `WITH first_article AS (
         SELECT DISTINCT ON (e.user_id) e.user_id, a.category_id
           FROM analytics_events e
           JOIN articles a ON a.id = e.entity_id
          WHERE e.event_name = 'page_view' AND e.entity_type = 'article'
            AND e.user_id IS NOT NULL
          ORDER BY e.user_id, e.occurred_at ASC
       )
       SELECT COALESCE(c.name, 'No article read') AS label,
              COUNT(DISTINCT p.user_id)::int AS customers,
              COALESCE(SUM(p.value_cents), 0)::bigint AS revenue_cents
         FROM analytics_events p
         LEFT JOIN first_article fa ON fa.user_id = p.user_id
         LEFT JOIN categories c ON c.id = fa.category_id
        WHERE p.event_name = 'payment' AND p.occurred_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY revenue_cents DESC`,
      [from, to]
    );

    res.json({
      window: { from, to },
      categories: categories.rows,
      tags: tagReads.rows,
      tagTaps: tagTaps.rows,
      searches: searches.rows,
      revenueByCategory: revenue.rows.map((r) => ({ ...r, revenue_cents: Number(r.revenue_cents) })),
      note: 'Categories are chosen by an editor and reliable immediately. Tags are '
        + 'derived from the text unless someone has edited them, so read them as a hint '
        + 'rather than a verdict until the tags themselves have been curated.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
