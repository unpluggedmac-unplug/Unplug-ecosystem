// The public address of the site, and how each kind of page is addressed.
//
// ONE PLACE. A sitemap that disagrees with the canonical tag, or a canonical
// that disagrees with the link people actually share, is worse than having
// neither: it tells search engines the same page lives at two addresses and
// splits whatever ranking it has earned. Every URL the backend emits comes
// from here.
//
// The origin is SITE_URL, which this codebase already uses elsewhere, rather
// than a new variable. It is normalised hard because a trailing slash or a
// bare hostname pasted into an environment variable is the sort of thing that
// produces "https://unplugnews.com//?p=article" in a live sitemap.

const DEFAULT_ORIGIN = 'https://www.unplugnews.com';

function siteOrigin() {
  const raw = String(process.env.SITE_URL || '').trim();
  if (!raw) return DEFAULT_ORIGIN;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    // Origin only — a path in SITE_URL would be doubled onto every link.
    return new URL(withScheme).origin;
  } catch (e) {
    return DEFAULT_ORIGIN;
  }
}

// The site is one page whose query string chooses what to render, so a public
// address is the origin plus a query — not a path. Written out per type so a
// change to the routing scheme has one place to happen rather than being
// spelled out in every query in the sitemap.
const PAGE_URLS = {
  home: () => '/',
  article: (id) => `/?p=article&id=${encodeURIComponent(id)}`,
  profile: (slug) => `/?p=profile&slug=${encodeURIComponent(slug)}`,
  member: (username) => `/?p=myunplug&u=${encodeURIComponent(username)}`,
  project: (id) => `/?p=project&id=${encodeURIComponent(id)}`,
  page: (key) => (key === 'home' ? '/' : `/?p=${encodeURIComponent(key)}`),
};

function absoluteUrl(pathOrQuery) {
  const p = String(pathOrQuery || '/');
  return siteOrigin() + (p.startsWith('/') ? p : '/' + p);
}

// The pages that exist regardless of content. Taken from the nav rather than
// invented: every one of these is reachable by a reader, which is the only
// honest reason to put something in a sitemap.
//
// changefreq is deliberately absent. Google has said for years that it
// ignores it, and a field nobody reads is a field that goes stale and lies.
const STATIC_PAGES = [
  { key: 'home', priority: '1.0' },
  { key: 'news', priority: '0.9' },
  { key: 'directory', priority: '0.9' },
  { key: 'editions', priority: '0.8' },
  { key: 'top10', priority: '0.8' },
  { key: 'competitions', priority: '0.7' },
  { key: 'gallery', priority: '0.7' },
  { key: 'investors', priority: '0.6' },
  { key: 'marketplace', priority: '0.6' },
  { key: 'members', priority: '0.6' },
  { key: 'deafcommunity', priority: '0.7' },
  { key: 'nominate', priority: '0.6' },
  { key: 'about', priority: '0.5' },
  { key: 'contact', priority: '0.5' },
  { key: 'brandplacement', priority: '0.4' },
  { key: 'privacy', priority: '0.3' },
  { key: 'terms', priority: '0.3' },
  { key: 'refunds', priority: '0.3' },
];

// XML text escaping. An ampersand in a query string is the common case here —
// "?p=article&id=5" is invalid XML until the & is escaped, and an unescaped
// one makes the whole sitemap unparseable rather than just that entry.
function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// W3C datetime, which is what <lastmod> takes. A null date yields null so the
// element can be left out rather than emitted empty.
function lastmod(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function urlEntry({ loc, lastmod: mod, priority }) {
  return '  <url>\n'
    + `    <loc>${xmlEscape(loc)}</loc>\n`
    + (mod ? `    <lastmod>${mod}</lastmod>\n` : '')
    + (priority ? `    <priority>${priority}</priority>\n` : '')
    + '  </url>';
}

function urlSet(entries) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + entries.map(urlEntry).join('\n') + '\n'
    + '</urlset>\n';
}

function sitemapIndex(children) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + children.map((c) => '  <sitemap>\n'
      + `    <loc>${xmlEscape(c.loc)}</loc>\n`
      + (c.lastmod ? `    <lastmod>${c.lastmod}</lastmod>\n` : '')
      + '  </sitemap>').join('\n') + '\n'
    + '</sitemapindex>\n';
}

module.exports = {
  siteOrigin, absoluteUrl, PAGE_URLS, STATIC_PAGES,
  xmlEscape, lastmod, urlSet, sitemapIndex,
};
