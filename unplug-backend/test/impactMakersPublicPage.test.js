// Impact Makers, part 3: the public gallery page.
//
// Static-source checks against unplug-magazine.html — the backend
// (impactMakers.test.js) covers the real API, the admin panel
// (impactMakersAdminUi.test.js) covers content management; these confirm
// the public page actually wires the flip-card gallery, filter/search and
// routing the plan committed to.
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

test('THE PAGE EXISTS AND THE ROUTER NEEDS NO NEW BRANCH — routeFromUrl\'s generic p-> page-p fallback covers it', () => {
  const src = readMagazine();
  assert.match(src, /<main class="page" id="page-impact-makers">/);
  // Confirms the id really is addressable by the existing generic fallback
  // (routeFromUrl: `else if (p && document.getElementById('page-' + p))`),
  // i.e. this page's id truly is "page-" + the "impact-makers" p value.
  assert.match(src, /id="page-impact-makers"/);
});

test('PAGE_TITLES, THE FIRST-LOAD GUARD AND BOTH NAV LINKS (MENU + FOOTER) ARE WIRED', () => {
  const src = readMagazine();
  assert.match(src, /'impact-makers': 'Impact Makers — Unplug Magazine'/);
  assert.match(src, /if \(pageId === 'impact-makers' && !impactMakersLoaded\) \{\s*\n\s*impactMakersLoaded = true;\s*\n\s*loadImpactMakersPage\(\);/);
  assert.match(src, /<a class="nav-item" href="\?p=impact-makers" data-page="impact-makers">/);
  assert.match(src, /<li><a href="\?p=impact-makers" data-page="impact-makers">Impact Makers<\/a><\/li>/);
});

test('THE HEADER CARRIES THE REQUESTED TITLE, TAGLINE AND EDITORIAL INTRO', () => {
  const src = readMagazine();
  const idx = src.indexOf('id="page-impact-makers"');
  const head = src.slice(idx, idx + 1200);
  assert.match(head, /Celebrating the people, brands and visionaries making a difference\./);
  assert.match(head, /Impact doesn't always make headlines\./);
});

test('THE BOTTOM CTA LINKS TO THE EXISTING CONTACT PAGE, NOT A NEW SUBMISSION FORM', () => {
  const src = readMagazine();
  const idx = src.indexOf('id="page-impact-makers"');
  const section = src.slice(idx, src.indexOf('</main>', idx));
  assert.match(section, /Become an Impact Maker/);
  assert.match(section, /data-page="contact"/);
});

test('THE FLIP-CARD CSS IS GENUINELY 3D (perspective / transform-style / backface-visibility / rotateY), AND RESPECTS REDUCED MOTION', () => {
  const src = readMagazine();
  assert.match(src, /\.im-card\{[^}]*perspective:/);
  assert.match(src, /\.im-card-inner\{[^}]*transform-style:preserve-3d/);
  assert.match(src, /\.im-card-face\{[^}]*backface-visibility:hidden/);
  assert.match(src, /\.im-card\.flipped \.im-card-inner\{[^}]*rotateY\(180deg\)/);
  assert.match(src, /prefers-reduced-motion:\s*reduce.*\.im-card-inner\{\s*transition:none/s);
});

test('THE GRID IS RESPONSIVE: 4 DESKTOP COLUMNS, NARROWING AT SMALLER BREAKPOINTS', () => {
  const src = readMagazine();
  assert.match(src, /\.im-grid\{[^}]*grid-template-columns:repeat\(4, 1fr\)/);
  assert.match(src, /@media\(max-width:1000px\)\{ \.im-grid\{ grid-template-columns:repeat\(3, 1fr\); \}/);
  assert.match(src, /@media\(max-width:700px\)\{ \.im-grid\{ grid-template-columns:repeat\(2, 1fr\)/);
  assert.match(src, /@media\(max-width:460px\)\{ \.im-grid\{ grid-template-columns:1fr; \}/);
});

test('A FEATURED CARD GETS A REAL VISUAL DISTINCTION, NOT JUST A DATA ATTRIBUTE NOBODY STYLES', () => {
  const src = readMagazine();
  assert.match(src, /\.im-card\.im-featured \.im-card-face\{[^}]*border-color:var\(--red\)/);
  assert.match(src, /impactMakerCardHtml\(m\) \{[\s\S]*?m\.featured \? ' im-featured' : ''/);
});

test('THE CARD FRONT SHOWS THE PHOTO AS THE DOMINANT ELEMENT, PLUS A DESIGNATION LABEL DERIVED FROM TYPE', () => {
  const src = readMagazine();
  assert.match(src, /function imDesignationLabel\(type\) \{\s*\n\s*if \(type === 'sponsor'\) return 'Impact Sponsor';\s*\n\s*if \(type === 'partner'\) return 'Impact Partner';\s*\n\s*return 'Impact Maker';/);
  assert.match(src, /class="im-card-face im-card-front"[\s\S]{0,80}\$\{photo\}/);
});

test('SOCIAL LINKS ONLY RENDER WHEN A REAL URL EXISTS, AND OPEN IN A NEW TAB — ALL 7 PLATFORMS', () => {
  const src = readMagazine();
  const idx = src.indexOf('const IM_SOCIAL_FIELDS');
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 300);
  for (const col of ['instagram_url', 'facebook_url', 'linkedin_url', 'tiktok_url', 'youtube_url', 'x_url', 'website_url']) {
    assert.match(body, new RegExp(col));
  }
  const filterIdx = src.indexOf('.filter(([col]) => m[col])');
  assert.ok(filterIdx > -1, 'a platform with no URL must be filtered out, not rendered empty');
  const nearby = src.slice(filterIdx, filterIdx + 200);
  assert.match(nearby, /target="_blank" rel="noopener"/);
});

test('FILTERING AND SEARCH ARE PURE CLIENT-SIDE — NO REFETCH ON EITHER ACTION', () => {
  const src = readMagazine();
  const filterFnIdx = src.indexOf('function imApplyFiltersAndRender()');
  assert.ok(filterFnIdx > -1);
  const filterFnBody = src.slice(filterFnIdx, src.indexOf('\n}', filterFnIdx));
  assert.ok(!/\bapi\(/.test(filterFnBody), 'applying a filter/search must never call the API — it filters the already-fetched array');

  const searchListenerIdx = src.indexOf("getElementById('imSearchInput').addEventListener('input'");
  assert.ok(searchListenerIdx > -1);
  const searchListenerBody = src.slice(searchListenerIdx, searchListenerIdx + 400);
  assert.match(searchListenerBody, /clearTimeout\(imSearchDebounce\)/);
  assert.match(searchListenerBody, /}, 350\)/, 'same 350ms debounce timing as the Members page search');
  assert.ok(!/\bapi\(/.test(searchListenerBody));
});

test('FILTER CHIPS ARE BUILT FROM CATEGORY, THE ONE ADMIN-MANAGEABLE PART OF THIS TAXONOMY', () => {
  const src = readMagazine();
  const idx = src.indexOf('function imRenderFilters(categories)');
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 400);
  assert.match(body, /data-filter="\$\{c\.id\}"/);
});

test('THE FLIP IS ACCESSIBLE: role=button, tabindex=0, aria-pressed, AND WORKS ON ENTER/SPACE WITH NO MOUSE', () => {
  const src = readMagazine();
  const cardIdx = src.indexOf('function impactMakerCardHtml(m)');
  const cardBody = src.slice(cardIdx, src.indexOf('function imApplyFiltersAndRender', cardIdx));
  assert.match(cardBody, /role="button" tabindex="0" aria-pressed="false"/);

  const keydownIdx = src.indexOf("e.target.closest && e.target.closest('.im-card')");
  assert.ok(keydownIdx > -1, 'a delegated keydown handler for the im-card must exist, matching the story-card pattern');
  const keydownBody = src.slice(Math.max(0, keydownIdx - 300), keydownIdx + 300);
  assert.match(keydownBody, /if \(e\.key !== 'Enter' && e\.key !== ' '\) return;/);
  assert.match(keydownBody, /classList\.toggle\('flipped'\)/);
});

test('CLICKING A SOCIAL LINK INSIDE THE FLIPPED CARD OPENS THE LINK, NOT ALSO RE-FLIPPING THE CARD', () => {
  const src = readMagazine();
  const idx = src.indexOf("getElementById('imGrid').addEventListener('click'");
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 300);
  assert.match(body, /e\.target\.closest\('a'\)/, 'a click landing on the <a> itself must be excluded from the toggle');
});

test('THE PAGE SETS ITS OWN SEO TITLE AND META DESCRIPTION ON LOAD', () => {
  const src = readMagazine();
  const idx = src.indexOf('async function loadImpactMakersPage()');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /seoSetTitle\('Impact Makers'\)/);
  assert.match(body, /seoSetDescription\('Meet the people, brands, sponsors, partners and visionaries making a difference through the Unplug Magazine Impact Makers platform\.'\)/);
});

test('FREE-TEXT VALUES GOING INTO AN ATTRIBUTE USE THE QUOTE-SAFE ESCAPE, NOT THE PLAIN ONE', () => {
  const src = readMagazine();
  const idx = src.indexOf('function impactMakerCardHtml(m)');
  const body = src.slice(idx, src.indexOf('function imApplyFiltersAndRender', idx));
  assert.match(body, /data-search="\$\{searchHaystack\}"/);
  assert.match(body, /const searchHaystack = escapeAttr\(/, 'a name/category containing a literal " must not break out of the attribute');
  assert.match(body, /aria-label="\$\{escapeAttr\(m\.display_name\)\}/);
});
