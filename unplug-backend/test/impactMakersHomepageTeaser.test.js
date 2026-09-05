// Impact Makers, part 4 (final): homepage teaser + sitemap.
//
// Static-source checks against unplug-magazine.html and sitemap.js — the
// backend, admin panel and full gallery page already have their own real-
// behaviour test files.
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readMagazine() {
  const file = path.join(__dirname, '..', '..', 'unplug-magazine.html');
  assert.ok(fs.existsSync(file));
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('THE HOMEPAGE TEASER SECTION EXISTS, CLONING "Highlighted Directory Profiles"\' EXACT SHAPE', () => {
  const src = readMagazine();
  const idx = src.indexOf('id="highlightedProfilesGrid"');
  assert.ok(idx > -1);
  const nearby = src.slice(idx, idx + 700);
  assert.match(nearby, /<h2>Impact Makers<\/h2>/);
  assert.match(nearby, /<button class="view-all" data-page="impact-makers">View all Impact Makers →<\/button>/);
  assert.match(nearby, /id="impactMakersTeaserGrid"/);
});

test('THE TEASER REUSES THE REAL CARD BUILDER FROM THE GALLERY PAGE, NOT A SECOND COPY', () => {
  const src = readMagazine();
  const idx = src.indexOf('async function loadImpactMakersTeaser()');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /shown\.map\(impactMakerCardHtml\)/, 'must call the same builder the full page uses, so a flip here behaves identically there');
});

test('THE TEASER SHOWS FEATURED IMPACT MAKERS FIRST, CAPPED AT 4, MATCHING THE OTHER HOMEPAGE TEASERS\' LIMIT', () => {
  const src = readMagazine();
  const idx = src.indexOf('async function loadImpactMakersTeaser()');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /m\.featured\).slice\(0, 4\)/);
  assert.match(body, /makers\.slice\(0, 4\)/, 'falls back to the first 4 published if nothing is marked featured yet');
});

test('THE TEASER LOADS ONCE AT SCRIPT INIT, ALONGSIDE EVERY OTHER HOMEPAGE TEASER — NOT BEHIND A PAGE-LOAD GUARD', () => {
  const src = readMagazine();
  const idx = src.indexOf("document.addEventListener('DOMContentLoaded', () => {");
  const body = src.slice(idx, src.indexOf('});', idx));
  assert.match(body, /loadHighlightedProfiles\(\);/);
  assert.match(body, /loadImpactMakersTeaser\(\);/);
});

test('THE FLIP CLICK LISTENER COVERS BOTH GRIDS: DELEGATED ON document, NOT SCOPED TO #imGrid ALONE', () => {
  const src = readMagazine();
  const idx = src.indexOf("const card = e.target.closest('.im-card');");
  const before = src.slice(Math.max(0, idx - 200), idx);
  assert.match(before, /^document\.addEventListener\('click'/m);
  assert.ok(!/getElementById\('imGrid'\)\.addEventListener\('click'/.test(src),
    'the old #imGrid-scoped listener must be gone, not just supplemented — otherwise a card could double-toggle');
});

test('THE SITEMAP LISTS THE IMPACT MAKERS LISTING PAGE, WITH NO PER-PROFILE ENTRIES YET (NONE EXIST IN THIS v1)', () => {
  const sitemapPath = path.join(__dirname, '..', 'src', 'routes', 'sitemap.js');
  const src = fs.readFileSync(sitemapPath, 'utf8');
  assert.match(src, /\{ path: '\/\?p=impact-makers'/);
  assert.ok(!/impact-maker&slug/.test(src), 'no per-profile sitemap entries yet — that page does not exist in this v1');
});
