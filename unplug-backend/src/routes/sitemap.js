const express = require('express');
const pool = require('../db');

const router = express.Router();

// The public site lives on a different host to this API, so the sitemap has
// to name that host explicitly. SITE_URL lets it follow the domain when
// unplugnews.com goes live without a code change.
const SITE_URL = (process.env.SITE_URL || 'https://www.unplugnews.com').replace(/\/$/, '');

// Pages that always exist, with rough change frequencies. Home and news move
// often; the legal pages almost never do.
const STATIC_PAGES = [
  { path: '/unplug-magazine.html', freq: 'daily', priority: '1.0' },
  { path: '/unplug-magazine.html?p=news', freq: 'daily', priority: '0.9' },
  { path: '/unplug-magazine.html?p=directory', freq: 'weekly', priority: '0.8' },
  { path: '/unplug-magazine.html?p=top10', freq: 'weekly', priority: '0.7' },
  { path: '/unplug-magazine.html?p=editions', freq: 'weekly', priority: '0.7' },
  { path: '/unplug-magazine.html?p=deafcommunity', freq: 'weekly', priority: '0.7' },
  { path: '/unplug-magazine.html?p=competitions', freq: 'weekly', priority: '0.6' },
  { path: '/unplug-magazine.html?p=gallery', freq: 'monthly', priority: '0.5' },
  { path: '/unplug-magazine.html?p=about', freq: 'monthly', priority: '0.5' },
  { path: '/unplug-magazine.html?p=contact', freq: 'monthly', priority: '0.5' },
  { path: '/unplug-magazine.html?p=privacy', freq: 'yearly', priority: '0.3' },
  { path: '/unplug-magazine.html?p=terms', freq: 'yearly', priority: '0.3' },
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
    const [articles, profiles] = await Promise.all([
      pool.query("SELECT id, published_at, created_at FROM articles WHERE status = 'approved' ORDER BY id"),
      pool.query("SELECT slug, updated_at FROM profiles WHERE status = 'approved' ORDER BY id"),
    ]);

    const entries = [
      ...STATIC_PAGES.map((p) => urlEntry(SITE_URL + p.path, null, p.freq, p.priority)),
      ...articles.rows.map((a) => urlEntry(
        `${SITE_URL}/unplug-magazine.html?p=article&id=${a.id}`,
        a.published_at || a.created_at, 'monthly', '0.8'
      )),
      ...profiles.rows.map((p) => urlEntry(
        `${SITE_URL}/unplug-magazine.html?p=profile&slug=${encodeURIComponent(p.slug)}`,
        p.updated_at, 'monthly', '0.6'
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

// GET /robots.txt — served here too so the API host doesn't get crawled as if
// it were the site.
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\nDisallow: /\n\nSitemap: ' + SITE_URL + '/sitemap.xml\n'
  );
});

module.exports = router;
