// Sitemaps, redirect lookup and the 404 log.
//
// SERVED FROM HERE, PRESENTED BY CLOUDFLARE. www.unplugnews.com is Cloudflare
// Pages and this API is a different origin, so a sitemap served only from here
// would live at the wrong domain for Search Console. A Pages Function fetches
// these and returns them under the public domain — see functions/ in the repo
// root. Everything in this file is therefore public and read-only except the
// admin section at the bottom.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const {
  siteOrigin, absoluteUrl, PAGE_URLS, STATIC_PAGES,
  lastmod, urlSet, sitemapIndex,
} = require('../utils/siteUrls');

const router = express.Router();

// Sitemaps are a snapshot, not a live query — a crawler asking twice a minute
// should not run the whole set again. Short enough that publishing something
// shows up quickly, long enough that a crawl cannot become a load problem.
const XML_CACHE_SECONDS = 900;

function sendXml(res, body) {
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', `public, max-age=${XML_CACHE_SECONDS}`);
  res.send(body);
}

// ---------------------------------------------------------------------------
// The index, and one child per content type.
//
// Split rather than one big file because a sitemap is capped at 50,000 URLs
// and 50MB, and because a crawler can then see which SECTION changed from the
// index alone instead of re-reading everything.
// ---------------------------------------------------------------------------

router.get('/sitemap.xml', async (req, res, next) => {
  try {
    // lastmod per child, so a crawler reading the index knows which parts are
    // worth re-fetching. Each is the newest thing in that section.
    const [articles, profiles, projects] = await Promise.all([
      pool.query(`SELECT MAX(GREATEST(published_at, created_at)) AS m FROM articles
                   WHERE status = 'approved'
                     AND (scheduled_for IS NULL OR scheduled_for <= CURRENT_DATE)`),
      pool.query(`SELECT MAX(updated_at) AS m FROM profiles WHERE status = 'approved'`),
      pool.query(`SELECT MAX(updated_at) AS m FROM projects WHERE status = 'published'`),
    ]);

    sendXml(res, sitemapIndex([
      { loc: absoluteUrl('/sitemap-pages.xml') },
      { loc: absoluteUrl('/sitemap-articles.xml'), lastmod: lastmod(articles.rows[0].m) },
      { loc: absoluteUrl('/sitemap-directory.xml'), lastmod: lastmod(profiles.rows[0].m) },
      { loc: absoluteUrl('/sitemap-projects.xml'), lastmod: lastmod(projects.rows[0].m) },
    ]));
  } catch (err) { next(err); }
});

router.get('/sitemap-pages.xml', (req, res) => {
  sendXml(res, urlSet(STATIC_PAGES.map((p) => ({
    loc: absoluteUrl(PAGE_URLS.page(p.key)),
    priority: p.priority,
  }))));
});

router.get('/sitemap-articles.xml', async (req, res, next) => {
  try {
    // Exactly what a reader can open: approved AND past its scheduled date.
    // A sitemap listing a future-dated article invites a crawl that 404s and
    // teaches the crawler the site is unreliable.
    const result = await pool.query(
      `SELECT id, published_at, created_at
         FROM articles
        WHERE status = 'approved'
          AND (scheduled_for IS NULL OR scheduled_for <= CURRENT_DATE)
        ORDER BY COALESCE(published_at, created_at) DESC
        LIMIT 50000`
    );
    sendXml(res, urlSet(result.rows.map((a) => ({
      loc: absoluteUrl(PAGE_URLS.article(a.id)),
      lastmod: lastmod(a.published_at || a.created_at),
      priority: '0.8',
    }))));
  } catch (err) { next(err); }
});

router.get('/sitemap-directory.xml', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT slug, updated_at FROM profiles
        WHERE status = 'approved' AND slug IS NOT NULL
        ORDER BY updated_at DESC LIMIT 50000`
    );
    sendXml(res, urlSet(result.rows.map((p) => ({
      loc: absoluteUrl(PAGE_URLS.profile(p.slug)),
      lastmod: lastmod(p.updated_at),
      priority: '0.7',
    }))));
  } catch (err) { next(err); }
});

router.get('/sitemap-projects.xml', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, updated_at FROM projects
        WHERE status = 'published' ORDER BY updated_at DESC LIMIT 50000`
    );
    sendXml(res, urlSet(result.rows.map((p) => ({
      loc: absoluteUrl(PAGE_URLS.project(p.id)),
      lastmod: lastmod(p.updated_at),
      priority: '0.6',
    }))));
  } catch (err) { next(err); }
});

// robots.txt — served from here so it can name the sitemap using the same
// origin everything else uses, rather than a copy that drifts.
router.get('/robots.txt', (req, res) => {
  const origin = siteOrigin();
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send([
    'User-agent: *',
    'Allow: /',
    '',
    '# Screens that need a sign-in. Nothing here is secret — these are kept',
    '# out of the index because a search result leading to a login form is a',
    '# dead end for a reader, not because the pages are sensitive.',
    'Disallow: /unplug-admin-dashboard',
    'Disallow: /unplug-member-dashboard',
    'Disallow: /unplug-checkout',
    '',
    '# Anything carrying a one-time token must never be indexed.',
    'Disallow: /*token=',
    'Disallow: /*reset=',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n'));
});

// ---------------------------------------------------------------------------
// Redirects — the lookup a Pages Function makes when a path 404s.
// ---------------------------------------------------------------------------

// Paths are compared in one normalised shape so "/About/", "about" and
// "/about" cannot become three different answers.
function normalisePath(value) {
  let p = String(value == null ? '' : value).trim();
  if (!p) return '';
  p = p.split('#')[0].split('?')[0];
  if (!p.startsWith('/')) p = '/' + p;
  // A trailing slash is dropped, except for the root itself.
  if (p.length > 1) p = p.replace(/\/+$/, '') || '/';
  return p.slice(0, 500);
}

// GET /seo/redirect?path=/old-page — public, called by the Pages Function on a
// miss. Deliberately cheap: one indexed lookup, and a 404 answer when there is
// no rule, so the Function can fall through to the real 404 page.
router.get('/redirect', async (req, res, next) => {
  try {
    const path = normalisePath(req.query.path);
    if (!path) return res.status(400).json({ error: 'A path is required.' });

    const found = await pool.query(
      `SELECT id, to_url, status_code FROM redirects
        WHERE LOWER(from_path) = LOWER($1) AND is_active = true LIMIT 1`,
      [path]
    );
    if (found.rowCount === 0) return res.status(404).json({ redirect: null });

    const rule = found.rows[0];
    // Counted, not awaited. The visitor is waiting on this response and a
    // statistic must never be the reason a redirect is slow.
    pool.query(
      'UPDATE redirects SET hit_count = hit_count + 1, last_hit_at = now() WHERE id = $1',
      [rule.id]
    ).catch((e) => console.error('[seo] redirect hit count failed:', e.message));

    res.json({ redirect: { to: rule.to_url, status: rule.status_code } });
  } catch (err) { next(err); }
});

// POST /seo/not-found — the Pages Function reports a genuine miss.
//
// Public on purpose: it is called by the edge on behalf of a reader who is not
// signed in. It stores one row per PATH with a counter rather than one per
// hit, so a broken link shared widely cannot fill the table.
router.post('/not-found', async (req, res, next) => {
  try {
    const path = normalisePath(req.body && req.body.path);
    if (!path) return res.status(400).json({ error: 'A path is required.' });
    const referrer = String((req.body && req.body.referrer) || '').trim().slice(0, 500) || null;

    await pool.query(
      `INSERT INTO not_found_log (path, last_referrer)
       VALUES ($1, $2)
       ON CONFLICT (path) DO UPDATE SET
         hit_count     = not_found_log.hit_count + 1,
         last_seen_at  = now(),
         last_referrer = COALESCE(EXCLUDED.last_referrer, not_found_log.last_referrer),
         -- A path that starts being asked for again is worth looking at again,
         -- even if it was marked dealt-with before.
         resolved      = false`,
      [path, referrer]
    );
    res.status(202).json({ logged: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

router.get('/admin/redirects', requireRole('admin'), async (req, res, next) => {
  try {
    const [rules, misses] = await Promise.all([
      pool.query(`SELECT * FROM redirects ORDER BY is_active DESC, hit_count DESC, from_path ASC`),
      // The list that turns "add redirects" into a task you can finish: real
      // misses, busiest first, with anything already handled filtered out.
      pool.query(`SELECT * FROM not_found_log
                   WHERE resolved = false
                   ORDER BY hit_count DESC, last_seen_at DESC LIMIT 100`),
    ]);
    res.json({ redirects: rules.rows, notFound: misses.rows });
  } catch (err) { next(err); }
});

function validateRule(body) {
  const from = normalisePath(body.fromPath);
  const to = String(body.toUrl || '').trim();
  if (!from || from === '/') {
    return { error: 'Give the path that should redirect, for example /old-page. The homepage cannot redirect to itself.' };
  }
  if (!to) return { error: 'Give the address to send people to.' };
  // A path on this site, or an absolute https URL. Anything else — a
  // javascript: address in particular — would be handed to a browser as a
  // Location header and followed without question.
  const isPath = to.startsWith('/') && !to.startsWith('//');
  const isHttps = /^https:\/\/[^/\s]+/i.test(to);
  if (!isPath && !isHttps) {
    return { error: 'Send people to a path on this site (/somewhere) or a full https:// address.' };
  }
  if (to.length > 1000) return { error: 'That destination is too long.' };

  const status = Number(body.statusCode || 301);
  if (![301, 302].includes(status)) {
    return { error: 'Choose 301 (moved for good) or 302 (temporary).' };
  }
  // A rule pointing at itself is an infinite loop the browser will give up on
  // after a few hops, showing the reader an error rather than a page.
  if (isPath && normalisePath(to) === from) {
    return { error: 'That would send the page to itself.' };
  }
  return { from, to, status, note: String(body.note || '').trim().slice(0, 300) || null };
}

router.post('/admin/redirects', requireRole('admin'), async (req, res, next) => {
  try {
    const v = validateRule(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // A chain (/a -> /b where /b -> /c) costs the reader an extra round trip
    // and search engines discount it. Refused with the reason rather than
    // silently accepted.
    const chained = await pool.query(
      `SELECT to_url FROM redirects WHERE LOWER(from_path) = LOWER($1) AND is_active = true`,
      [normalisePath(v.to)]
    );
    if (chained.rowCount > 0) {
      return res.status(400).json({
        error: `That destination itself redirects to ${chained.rows[0].to_url}. Point this rule straight there instead.`,
      });
    }

    const result = await pool.query(
      `INSERT INTO redirects (from_path, to_url, status_code, note, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (LOWER(from_path)) DO UPDATE SET
         to_url = EXCLUDED.to_url, status_code = EXCLUDED.status_code,
         note = EXCLUDED.note, is_active = true, updated_at = now()
       RETURNING *`,
      [v.from, v.to, v.status, v.note, req.user.id]
    );
    // Creating the rule is what marks the miss as handled — no second step to
    // forget.
    await pool.query('UPDATE not_found_log SET resolved = true WHERE path = $1', [v.from]);
    logActivity(req.user.id, 'redirect_created', `${v.from} -> ${v.to}`);
    res.status(201).json({ redirect: result.rows[0] });
  } catch (err) { next(err); }
});

router.patch('/admin/redirects/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid redirect is required.' });
    if (typeof req.body.isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be true or false.' });
    }
    const result = await pool.query(
      'UPDATE redirects SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [req.body.isActive, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'That redirect no longer exists.' });
    res.json({ redirect: result.rows[0] });
  } catch (err) { next(err); }
});

router.delete('/admin/redirects/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid redirect is required.' });
    const result = await pool.query('DELETE FROM redirects WHERE id = $1 RETURNING from_path', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'That redirect no longer exists.' });
    logActivity(req.user.id, 'redirect_deleted', result.rows[0].from_path);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Dismiss a miss without creating a rule — plenty are bots probing for
// /wp-login.php and will never deserve a redirect.
router.patch('/admin/not-found', requireRole('admin'), async (req, res, next) => {
  try {
    const path = normalisePath(req.body && req.body.path);
    if (!path) return res.status(400).json({ error: 'A path is required.' });
    await pool.query('UPDATE not_found_log SET resolved = true WHERE path = $1', [path]);
    res.json({ dismissed: true });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.normalisePath = normalisePath;
