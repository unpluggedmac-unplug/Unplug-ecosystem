const express = require('express');
const pool = require('../db');

const router = express.Router();

// The public site lives on a different host to this API, so the sitemap has
// to name that host explicitly. SITE_URL lets it follow the domain when
// unplugnews.com goes live without a code change.
const SITE_URL = (process.env.SITE_URL || 'https://www.unplugnews.com').replace(/\/$/, '');

// Pages that always exist, with rough change frequencies. Home and news move
// often; the legal pages almost never do.
//
// The paths are the CANONICAL "/?p=..." form, matching what each page's
// canonical tag actually says. They used to be "/unplug-magazine.html?p=...",
// which pointed a crawler at one address only for the page to declare a
// different one — wasted crawl, and the two forms competing for the same
// content.
const STATIC_PAGES = [
  { path: '/', freq: 'daily', priority: '1.0' },
  { path: '/?p=news', freq: 'daily', priority: '0.9' },
  { path: '/?p=directory', freq: 'weekly', priority: '0.8' },
  { path: '/?p=top10', freq: 'weekly', priority: '0.7' },
  { path: '/?p=editions', freq: 'weekly', priority: '0.7' },
  { path: '/?p=deafcommunity', freq: 'weekly', priority: '0.7' },
  { path: '/?p=competitions', freq: 'weekly', priority: '0.6' },
  { path: '/?p=gallery', freq: 'monthly', priority: '0.5' },
  // Individual Impact Maker profiles have no page of their own yet (see
  // migrations/175_impact_makers.sql) — only the listing page is indexable
  // for now; a per-profile entries block can join the article/profile ones
  // below once that page exists, with no other change needed here.
  { path: '/?p=impact-makers', freq: 'weekly', priority: '0.6' },
  { path: '/?p=about', freq: 'monthly', priority: '0.5' },
  { path: '/?p=contact', freq: 'monthly', priority: '0.5' },
  // Listed even though it is not in the site's navigation. It is out of the
  // nav on purpose, not hidden — it is the page a social bio points at, and
  // somebody searching "nominate unplug" should still find it. The path form
  // is used because that is the canonical this page now sets for itself; the
  // old ?p=nominate still works but must not be advertised as a second URL
  // for the same page.
  { path: '/nominate', freq: 'monthly', priority: '0.6' },
  { path: '/?p=privacy', freq: 'yearly', priority: '0.3' },
  { path: '/?p=terms', freq: 'yearly', priority: '0.3' },
  { path: '/?p=refunds', freq: 'yearly', priority: '0.3' },
];

// & < > etc. must be escaped inside XML or the whole document fails to parse
// — and slugs/ids do end up in these URLs.
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function urlEntry(loc, lastmod, freq, priority) {
  return '  <url>\n'
    + `    <loc>${xmlEscape(loc)}</loc>\n`
    + (lastmod ? `    <lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>\n` : '')
    + (freq ? `    <changefreq>${freq}</changefreq>\n` : '')
    + (priority ? `    <priority>${priority}</priority>\n` : '')
    + '  </url>';
}

// GET /sitemap.xml — built from live content so new stories and listings are
// discoverable without anyone regenerating a file.
router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const [articles, profiles, projects] = await Promise.all([
      // scheduled_for matters: an approved article dated next week is not
      // readable yet, and listing it invites a crawl that 404s — which is how
      // a site teaches Google its sitemap cannot be trusted.
      pool.query(`SELECT id, published_at, created_at FROM articles
                   WHERE status = 'approved'
                     AND (scheduled_for IS NULL OR scheduled_for <= CURRENT_DATE)
                   ORDER BY id`),
      pool.query(`SELECT slug, updated_at FROM profiles
                   WHERE status = 'approved' AND slug IS NOT NULL ORDER BY id`),
      // Investor project showcases are public pages too and were missing.
      pool.query(`SELECT id, updated_at FROM projects
                   WHERE status = 'published' ORDER BY id`),
    ]);

    const entries = [
      ...STATIC_PAGES.map((p) => urlEntry(SITE_URL + p.path, null, p.freq, p.priority)),
      ...articles.rows.map((a) => urlEntry(
        `${SITE_URL}/?p=article&id=${a.id}`,
        a.published_at || a.created_at, 'monthly', '0.8'
      )),
      ...profiles.rows.map((p) => urlEntry(
        `${SITE_URL}/?p=profile&slug=${encodeURIComponent(p.slug)}`,
        p.updated_at, 'monthly', '0.6'
      )),
      ...projects.rows.map((pr) => urlEntry(
        `${SITE_URL}/?p=project&id=${pr.id}`,
        pr.updated_at, 'monthly', '0.5'
      )),
    ];

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + entries.join('\n')
      + '\n</urlset>\n';

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (err) {
    next(err);
  }
});

// GET /robots.txt — for the API HOST ONLY, and deliberately "Disallow: /".
//
// This is the opposite of what the public site serves, and that is correct:
// nothing on the API is a page a reader should find in search results, and an
// indexed JSON endpoint competes with the real page for the same content.
//
// IT MUST NEVER BE PROXIED ONTO THE PUBLIC DOMAIN. Serving this file at
// www.unplugnews.com would tell every crawler to index nothing at all. The
// public robots.txt is a static file in the repository root.
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\nDisallow: /\n\nSitemap: ' + SITE_URL + '/sitemap.xml\n'
  );
});

module.exports = router;
