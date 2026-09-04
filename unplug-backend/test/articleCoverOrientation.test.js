// Article cover image, landscape or portrait — the person publishing an
// article (admin or member) can now choose which shape to bring, rather
// than a single fixed 16:9. The choice offered is deliberately the two
// ratios Facebook/Twitter and Instagram themselves use for a link
// preview/post, not a third, site-invented one — the cover image doubles
// as the article's own og:image/twitter:image (see seoSetImage in
// unplug-magazine.html), so this is what those platforms actually show.
//
// Requested directly: "landscape 1080 x 566px (1.91:1) or portrait
// 1080 x 1350px (4:5)".
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readBackend(relPath) {
  const file = path.join(__dirname, '..', relPath);
  assert.ok(fs.existsSync(file), `${relPath} should exist`);
  return fs.readFileSync(file, 'utf8');
}

function readSite(filename) {
  const file = path.join(__dirname, '..', '..', filename);
  assert.ok(fs.existsSync(file), `${filename} should exist`);
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('THE TWO NEW SPECS MATCH THE EXACT DIMENSIONS AND RATIOS REQUESTED', () => {
  const { IMAGE_SPECS } = require('../src/utils/imageSpecs');
  const landscape = IMAGE_SPECS.article_cover_landscape;
  const portrait = IMAGE_SPECS.article_cover_portrait;
  assert.ok(landscape && portrait, 'both new specs must exist');

  assert.equal(landscape.w, 1080);
  assert.equal(landscape.h, 566);
  assert.ok(Math.abs(landscape.w / landscape.h - 1.91) < 0.01, `expected ~1.91:1, got ${landscape.w}×${landscape.h}`);

  assert.equal(portrait.w, 1080);
  assert.equal(portrait.h, 1350);
  assert.ok(Math.abs(portrait.w / portrait.h - 0.8) < 0.01, `expected 4:5 (0.8), got ${portrait.w}×${portrait.h}`);
});

test('THE OLD article_cover SPEC IS UNTOUCHED — STILL USED BY THE UNRELATED HIGHLIGHT-BOOST OVERRIDE IMAGE', () => {
  const { IMAGE_SPECS } = require('../src/utils/imageSpecs');
  assert.equal(IMAGE_SPECS.article_cover.w, 1920);
  assert.equal(IMAGE_SPECS.article_cover.h, 1080);
});

test('GET /image-specs EXPOSES BOTH NEW KEYS TO A SIGNED-IN CALLER', async () => {
  const { requireAuth } = require('../src/middleware/auth');
  const jwt = require('jsonwebtoken');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-covertest';
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1, role: 'member' }; next(); });
  app.use('/image-specs', require('../src/routes/imageSpecs'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(base + '/image-specs');
    const body = await res.json();
    assert.ok(body.specs.article_cover_landscape);
    assert.ok(body.specs.article_cover_portrait);
    assert.equal(body.specs.article_cover_landscape.w, 1080);
    assert.equal(body.specs.article_cover_portrait.h, 1350);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ------------------------------------------------------------- member form

test('MEMBER FORM: A LANDSCAPE/PORTRAIT TOGGLE EXISTS NEXT TO THE COVER UPLOAD FIELD', () => {
  const src = readSite('unplug-member-dashboard.html');
  const idx = src.indexOf('id="art-cover-upload"');
  assert.ok(idx > -1);
  const before = src.slice(Math.max(0, idx - 700), idx);
  assert.match(before, /name="art-cover-orientation" value="landscape" checked/);
  assert.match(before, /name="art-cover-orientation" value="portrait"/);
});

test('MEMBER FORM: SWITCHING ORIENTATION RE-RENDERS THE WIDGET, PRESERVING WHATEVER IS ALREADY UPLOADED', () => {
  const src = readSite('unplug-member-dashboard.html');
  const idx = src.indexOf('function artEnsureCoverField()');
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 700);
  assert.match(body, /UnplugUpload\.valueOf\(el\)/, 'the current value must be read before re-rendering, not discarded');
  assert.match(body, /artCoverSpecFor\(radio\.value\)/);
});

test('MEMBER FORM: BOTH ORIENTATIONS RESOLVE THROUGH THE REAL SERVER SPEC, NOT A LOCAL GUESS', () => {
  const src = readSite('unplug-member-dashboard.html');
  const idx = src.indexOf('function artCoverSpecFor(orientation)');
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 200);
  assert.match(body, /imgSpecFull\(orientation === 'portrait' \? 'article_cover_portrait' : 'article_cover_landscape'\)/);
});

// -------------------------------------------------------------- admin form

test('ADMIN FORM: A LANDSCAPE/PORTRAIT TOGGLE EXISTS NEXT TO THE MAIN IMAGE FIELD', () => {
  const src = readSite('unplug-admin-dashboard.html');
  const idx = src.indexOf('id="artBannerUpload"');
  assert.ok(idx > -1);
  const before = src.slice(Math.max(0, idx - 700), idx);
  assert.match(before, /name="artCoverOrientation" value="landscape" checked/);
  assert.match(before, /name="artCoverOrientation" value="portrait"/);
});

test('ADMIN FORM: A FRESH ARTICLE RESETS THE TOGGLE BACK TO LANDSCAPE', () => {
  const src = readSite('unplug-admin-dashboard.html');
  const idx = src.indexOf('function artReset()');
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 600);
  assert.match(body, /input\[name="artCoverOrientation"\]\[value="landscape"\]/);
});

test('ADMIN FORM: LOADING AN EXISTING ARTICLE DETECTS ORIENTATION FROM THE REAL IMAGE, NOT A BLIND DEFAULT', () => {
  const src = readSite('unplug-admin-dashboard.html');
  const idx = src.indexOf('artRenderCoverField(a.banner_image_url || \'\')');
  assert.ok(idx > -1, 'the initial render must still happen immediately, defaulting to landscape');
  const body = src.slice(idx, idx + 500);
  assert.match(body, /probe\.naturalHeight > probe\.naturalWidth/, 'a taller-than-wide real image must flip the toggle to portrait');
  assert.match(body, /value="portrait"\]'?\)?\.checked = true/);
});

test('ADMIN FORM: THE THREE RENDER SITES ALL GO THROUGH THE ONE SHARED HELPER, NOT THREE SEPARATE COPIES', () => {
  const src = readSite('unplug-admin-dashboard.html');
  const calls = [...src.matchAll(/artRenderCoverField\(/g)];
  assert.ok(calls.length >= 3, `expected at least 3 call sites, got ${calls.length}`);
  // The ONLY place allowed to build the widget's HTML directly is the shared
  // helper itself — every render call site should go through it instead.
  const idx = src.indexOf('function artRenderCoverField(value)');
  assert.ok(idx > -1);
  const helperBody = src.slice(idx, src.indexOf('\n}', idx));
  const directCalls = [...src.matchAll(/UnplugUpload\.fieldHtml\('bannerImage'/g)];
  assert.equal(directCalls.length, 1, 'exactly one direct call should exist, inside the shared helper');
  assert.ok(helperBody.includes("UnplugUpload.fieldHtml('bannerImage'"), 'the one direct call must be inside artRenderCoverField');
});
