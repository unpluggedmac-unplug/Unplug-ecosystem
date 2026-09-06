const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

function reportWindow(req) {
  const now = new Date();
  const to = req.query.to ? new Date(req.query.to) : new Date(now.getTime() + 1000);
  const from = req.query.from ? new Date(req.query.from) : new Date(now.getTime() - 30 * 864e5);
  const safeTo = Number.isNaN(to.getTime()) ? new Date(now.getTime() + 1000) : to;
  const safeFrom = Number.isNaN(from.getTime()) ? new Date(now.getTime() - 30 * 864e5) : from;
  const maxFrom = new Date(safeTo.getTime() - 3660 * 864e5); // 10 years max for business history.
  return { from: safeFrom < maxFrom ? maxFrom : safeFrom, to: safeTo };
}

async function scalar(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows[0] || {};
}

async function tableExists(name) {
  const r = await pool.query('SELECT to_regclass($1) AS name', [`public.${name}`]);
  return Boolean(r.rows[0] && r.rows[0].name);
}

async function optionalScalar(table, sql, params = []) {
  if (!(await tableExists(table))) return {};
  return scalar(sql, params);
}

async function optionalRows(table, sql, params = []) {
  if (!(await tableExists(table))) return [];
  const r = await pool.query(sql, params);
  return r.rows;
}

const num = (v) => Number(v || 0);

async function gather(from, to) {
  const p = [from, to];
  const duration = Math.max(1, to.getTime() - from.getTime());
  const previousTo = new Date(from.getTime());
  const previousFrom = new Date(from.getTime() - duration);
  const pp = [previousFrom, previousTo];

  const [members, membersPrev, payments, paymentsPrev, pendingPayments, views, viewsPrev,
    articles, events, profiles, gallery, entries, votes, inquiries, activities] = await Promise.all([
    scalar(`SELECT COUNT(*)::int AS n FROM users WHERE created_at BETWEEN $1 AND $2`, p),
    scalar(`SELECT COUNT(*)::int AS n FROM users WHERE created_at BETWEEN $1 AND $2`, pp),
    scalar(`SELECT COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed_count,
                   COALESCE(SUM(amount) FILTER (WHERE status='confirmed'),0)::numeric AS revenue,
                   COUNT(*) FILTER (WHERE status='failed')::int AS failed_count,
                   COUNT(*) FILTER (WHERE status='pending')::int AS pending_created
              FROM payments WHERE COALESCE(confirmed_at, created_at) BETWEEN $1 AND $2`, p),
    scalar(`SELECT COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed_count,
                   COALESCE(SUM(amount) FILTER (WHERE status='confirmed'),0)::numeric AS revenue
              FROM payments WHERE COALESCE(confirmed_at, created_at) BETWEEN $1 AND $2`, pp),
    scalar(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS amount FROM payments WHERE status='pending'`),
    optionalScalar('page_views', `SELECT COUNT(*)::int AS views, COUNT(DISTINCT session_id)::int AS visitors
                                    FROM page_views WHERE viewed_at BETWEEN $1 AND $2`, p),
    optionalScalar('page_views', `SELECT COUNT(*)::int AS views, COUNT(DISTINCT session_id)::int AS visitors
                                    FROM page_views WHERE viewed_at BETWEEN $1 AND $2`, pp),
    scalar(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='approved')::int AS approved,
                   COUNT(*) FILTER (WHERE status='pending')::int AS pending
              FROM articles WHERE created_at BETWEEN $1 AND $2`, p),
    scalar(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='approved')::int AS approved,
                   COUNT(*) FILTER (WHERE status='pending')::int AS pending
              FROM events WHERE created_at BETWEEN $1 AND $2`, p),
    scalar(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='approved')::int AS approved,
                   COUNT(*) FILTER (WHERE status='pending')::int AS pending
              FROM profiles WHERE created_at BETWEEN $1 AND $2`, p),
    scalar(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='approved')::int AS approved,
                   COUNT(*) FILTER (WHERE status='pending')::int AS pending
              FROM gallery_images WHERE created_at BETWEEN $1 AND $2`, p),
    scalar(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='approved')::int AS approved,
                   COUNT(*) FILTER (WHERE status IN ('pending','resubmitted'))::int AS pending
              FROM competition_entries WHERE created_at BETWEEN $1 AND $2`, p),
    scalar(`SELECT COUNT(*)::int AS actions, COALESCE(SUM(bundle_size),0)::int AS votes
              FROM votes WHERE created_at BETWEEN $1 AND $2`, p),
    optionalScalar('inquiries', `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='new')::int AS new_count
                                  FROM inquiries WHERE created_at BETWEEN $1 AND $2`, p),
    optionalScalar('admin_activity_log', `SELECT COUNT(*)::int AS n FROM admin_activity_log WHERE created_at BETWEEN $1 AND $2`, p),
  ]);

  const forms = await optionalScalar('form_submissions',
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='new')::int AS new_count
       FROM form_submissions WHERE created_at BETWEEN $1 AND $2`, p);
  const banners = await optionalScalar('ad_slots',
    `SELECT COUNT(*) FILTER (WHERE created_at BETWEEN $1 AND $2)::int AS submitted,
            COUNT(*) FILTER (WHERE is_active=true AND (starts_at IS NULL OR starts_at <= CURRENT_DATE)
                              AND (ends_at IS NULL OR ends_at >= CURRENT_DATE))::int AS active
       FROM ad_slots`, p);
  const adAnalytics = await optionalScalar('ad_banner_analytics',
    `SELECT COALESCE(SUM(impressions),0)::bigint AS impressions,
            COALESCE(SUM(clicks),0)::bigint AS clicks
       FROM ad_banner_analytics WHERE event_date BETWEEN $1::date AND $2::date`, p);
  const sessions = await optionalScalar('analytics_sessions',
    `SELECT COUNT(*)::int AS sessions, COUNT(DISTINCT visitor_id)::int AS visitors,
            COALESCE(SUM(page_count),0)::int AS page_views
       FROM analytics_sessions WHERE started_at BETWEEN $1 AND $2`, p);

  const submissionTotal = num(articles.total) + num(events.total) + num(profiles.total)
    + num(gallery.total) + num(entries.total) + num(forms.total) + num(banners.submitted);
  const approvedCreated = num(articles.approved) + num(events.approved) + num(profiles.approved)
    + num(gallery.approved) + num(entries.approved);

  const paymentTypes = await pool.query(
    `SELECT linked_type, COUNT(*)::int AS payments, COALESCE(SUM(amount),0)::numeric AS revenue
       FROM payments WHERE status='confirmed' AND COALESCE(confirmed_at, created_at) BETWEEN $1 AND $2
      GROUP BY linked_type ORDER BY revenue DESC, payments DESC`, p);

  const statusNow = await Promise.all([
    scalar(`SELECT COUNT(*)::int AS n FROM articles WHERE status='pending'`),
    scalar(`SELECT COUNT(*)::int AS n FROM events WHERE status='pending'`),
    scalar(`SELECT COUNT(*)::int AS n FROM profiles WHERE status='pending'`),
    scalar(`SELECT COUNT(*)::int AS n FROM gallery_images WHERE status='pending'`),
    scalar(`SELECT COUNT(*)::int AS n FROM competition_entries WHERE status IN ('pending','resubmitted')`),
  ]);
  const pendingApprovals = statusNow.reduce((s, r) => s + num(r.n), 0);

  const dailyQueries = await Promise.all([
    scalar(`SELECT 1`), // Keeps Promise shape stable; rows are fetched below.
    pool.query(`SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, COUNT(*)::int AS n
                  FROM users WHERE created_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, p),
    pool.query(`SELECT to_char(date_trunc('day', COALESCE(confirmed_at, created_at)),'YYYY-MM-DD') AS day,
                       COUNT(*) FILTER (WHERE status='confirmed')::int AS payments,
                       COALESCE(SUM(amount) FILTER (WHERE status='confirmed'),0)::numeric AS revenue
                  FROM payments WHERE COALESCE(confirmed_at, created_at) BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, p),
    pool.query(`SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, COUNT(*)::int AS n
                  FROM articles WHERE created_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, p),
    pool.query(`SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, COALESCE(SUM(bundle_size),0)::int AS n
                  FROM votes WHERE created_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, p),
  ]);
  const dailyViews = await optionalRows('page_views',
    `SELECT to_char(date_trunc('day', viewed_at),'YYYY-MM-DD') AS day, COUNT(*)::int AS n
       FROM page_views WHERE viewed_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, p);
  const map = new Map();
  const ensure = (day) => { if (!map.has(day)) map.set(day, { day, members:0, revenue:0, payments:0, articles:0, votes:0, views:0 }); return map.get(day); };
  dailyQueries[1].rows.forEach((r) => { ensure(r.day).members = num(r.n); });
  dailyQueries[2].rows.forEach((r) => { const d=ensure(r.day); d.revenue=num(r.revenue); d.payments=num(r.payments); });
  dailyQueries[3].rows.forEach((r) => { ensure(r.day).articles = num(r.n); });
  dailyQueries[4].rows.forEach((r) => { ensure(r.day).votes = num(r.n); });
  dailyViews.forEach((r) => { ensure(r.day).views = num(r.n); });

  return {
    window: { from, to, previousFrom, previousTo },
    headline: {
      revenue: num(payments.revenue), confirmedPayments: num(payments.confirmed_count),
      pendingPaymentCount: num(pendingPayments.n), pendingPaymentAmount: num(pendingPayments.amount),
      newMembers: num(members.n), submissions: submissionTotal, approvedCreated,
      pendingApprovals, pageViews: num(views.views || sessions.page_views),
      visitors: num(sessions.visitors || views.visitors), votes: num(votes.votes),
      inquiries: num(inquiries.total) + num(forms.total), activeBanners: num(banners.active),
      bannerImpressions: num(adAnalytics.impressions), bannerClicks: num(adAnalytics.clicks),
      bannerCtr: num(adAnalytics.impressions) ? Math.round(num(adAnalytics.clicks) / num(adAnalytics.impressions) * 10000) / 100 : 0,
      adminActions: num(activities.n),
    },
    comparison: {
      revenue: num(paymentsPrev.revenue), confirmedPayments: num(paymentsPrev.confirmed_count),
      newMembers: num(membersPrev.n), pageViews: num(viewsPrev.views),
    },
    operations: {
      articles, events, profiles, gallery, competitionEntries: entries,
      forms, inquiries, bannerSubmissions: num(banners.submitted), voteActions: num(votes.actions), votes: num(votes.votes),
      failedPayments: num(payments.failed_count), pendingPaymentsCreated: num(payments.pending_created),
    },
    revenueByService: paymentTypes.rows.map((r) => ({ ...r, revenue: num(r.revenue), payments: num(r.payments) })),
    daily: Array.from(map.values()).sort((a,b) => a.day.localeCompare(b.day)),
  };
}

function pct(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function flatRows(report) {
  const h = report.headline;
  const rows = [
    ['Summary','Revenue',h.revenue,'ZAR'], ['Summary','Confirmed payments',h.confirmedPayments,'count'],
    ['Summary','Pending payment value',h.pendingPaymentAmount,'ZAR'], ['Summary','Pending payments',h.pendingPaymentCount,'count'],
    ['Growth','New members',h.newMembers,'count'], ['Operations','Submissions',h.submissions,'count'],
    ['Operations','Pending approvals now',h.pendingApprovals,'count'], ['Audience','Page views',h.pageViews,'count'],
    ['Audience','Visitors',h.visitors,'count'], ['Competitions','Votes',h.votes,'votes'],
    ['CRM','Enquiries / form submissions',h.inquiries,'count'], ['Advertising','Active banners',h.activeBanners,'count'],
    ['Advertising','Banner impressions',h.bannerImpressions,'count'], ['Advertising','Banner clicks',h.bannerClicks,'count'],
    ['Advertising','Banner CTR',h.bannerCtr,'percent'], ['Governance','Admin actions',h.adminActions,'count'],
  ];
  report.revenueByService.forEach((r) => rows.push(['Revenue by service', r.linked_type, r.revenue, 'ZAR']));
  report.daily.forEach((d) => {
    rows.push(['Daily', `${d.day} revenue`, d.revenue, 'ZAR']);
    rows.push(['Daily', `${d.day} members`, d.members, 'count']);
    rows.push(['Daily', `${d.day} views`, d.views, 'count']);
    rows.push(['Daily', `${d.day} votes`, d.votes, 'votes']);
  });
  return rows;
}

router.get('/summary', requireRole('admin'), async (req, res, next) => {
  try {
    const { from, to } = reportWindow(req);
    const report = await gather(from, to);
    report.change = {
      revenuePct: pct(report.headline.revenue, report.comparison.revenue),
      paymentsPct: pct(report.headline.confirmedPayments, report.comparison.confirmedPayments),
      membersPct: pct(report.headline.newMembers, report.comparison.newMembers),
      viewsPct: pct(report.headline.pageViews, report.comparison.pageViews),
    };
    res.json(report);
  } catch (err) { next(err); }
});

router.get('/export.csv', requireRole('admin'), async (req, res, next) => {
  try {
    const { from, to } = reportWindow(req);
    const report = await gather(from, to);
    const rows = [['Category','Metric','Value','Unit','From','To'],
      ...flatRows(report).map((r) => [...r, from.toISOString(), to.toISOString()])];
    const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const name = `unplug-report-${from.toISOString().slice(0,10)}-to-${to.toISOString().slice(0,10)}.csv`;
    res.set('Content-Type','text/csv; charset=utf-8');
    res.set('Content-Disposition',`attachment; filename="${name}"`);
    res.send(csv);
  } catch (err) { next(err); }
});

// Dependency-free Excel-compatible export. Excel opens this .xls HTML table
// natively; it avoids adding a large spreadsheet library solely for one export.
router.get('/export.xls', requireRole('admin'), async (req, res, next) => {
  try {
    const { from, to } = reportWindow(req);
    const report = await gather(from, to);
    const esc = (v) => String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const rows = flatRows(report);
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><table border="1"><tr><th>Category</th><th>Metric</th><th>Value</th><th>Unit</th><th>From</th><th>To</th></tr>${rows.map((r)=>`<tr>${[...r,from.toISOString(),to.toISOString()].map((v)=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</table></body></html>`;
    const name = `unplug-report-${from.toISOString().slice(0,10)}-to-${to.toISOString().slice(0,10)}.xls`;
    res.set('Content-Type','application/vnd.ms-excel; charset=utf-8');
    res.set('Content-Disposition',`attachment; filename="${name}"`);
    res.send(html);
  } catch (err) { next(err); }
});

module.exports = router;
