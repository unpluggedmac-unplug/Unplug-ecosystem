const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('Cloudflare serves clean article paths through the magazine SPA', () => {
  const redirects = read('_redirects');
  assert.match(redirects, /^\/articles\/\*\s+\/unplug-magazine\s+200$/m);
});

test('frontend routes, shares and canonicalises articles by permanent slug', () => {
  const html = read('unplug-magazine.html');
  assert.match(html, /function articlePublicPath\(/);
  assert.match(html, /return '\/articles\/' \+ encodeURIComponent\(slug\.toLowerCase\(\)\)/);
  assert.match(html, /function articleSlugFromPath\(/);
  assert.match(html, /loadArticleDetail\(articleSlugFromPath\(\)\)/);
  assert.match(html, /const shareUrl = articlePublicUrl\(a, id\)/);
  assert.match(html, /history\.replaceState\(\{ p: 'article', id, slug: a\.slug \|\| null \}, '', q\)/);
});

test('edge validates clean article paths and injects crawler metadata', () => {
  const edge = read('functions/[[path]].js');
  assert.match(edge, /const ARTICLE_PATH =/);
  assert.match(edge, /articleMetaBySlug/);
  assert.match(edge, /\/articles\/by-slug\//);
  assert.match(edge, /lookup\.status === 404/);
  assert.match(edge, /Response\.redirect[\s\S]*301/);
});

test('backend resolves current slugs and preserves historical ones', () => {
  const routes = read('unplug-backend/src/routes/articles.js');
  const migration = read('unplug-backend/db/migrations/219_article_slug_redirects.sql');
  assert.match(routes, /router\.get\('\/by-slug\/:slug'/);
  assert.match(routes, /article_slug_redirects/);
  assert.match(routes, /redirectSlug/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS article_slug_redirects/);
  assert.match(migration, /old_slug VARCHAR\(96\) NOT NULL UNIQUE/);
});

test('sitemap advertises clean article URLs', () => {
  const sitemap = read('unplug-backend/src/routes/sitemap.js');
  assert.match(sitemap, /SELECT id, slug, published_at, created_at FROM articles/);
  assert.match(sitemap, /SITE_URL\}\/articles\/\$\{encodeURIComponent\(a\.slug\)\}/);
});
