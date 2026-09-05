// Each article SECTION's own picture, landscape or portrait — requested
// directly, as an extension of the article cover's own landscape/portrait
// choice (articleCoverOrientation.test.js) to the body/section picture
// fields shown in the admin and member Story Builder.
//
// This one is a genuinely different case from the cover: .art-figure img is
// height:auto with NO forced crop box (confirmed in unplug-magazine.html),
// so whichever shape is chosen actually shows at its own real proportions on
// the live article page — unlike the cover (always cropped into fixed story
// cards regardless of choice) or the "More images" gallery (.art-gallery img
// is a fixed aspect-ratio:4/3 box, so a portrait crop there would still be
// squeezed back to landscape). That's why only the per-SECTION field gets
// this toggle, not the gallery — confirmed by checking article_body_image
// (the gallery's spec) is untouched, and a NEW pair of keys exists just for
// the section field.
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readSite(filename) {
  const file = path.join(__dirname, '..', '..', filename);
  assert.ok(fs.existsSync(file), `${filename} should exist`);
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('THE TWO NEW SPECS ARE A STRAIGHT 4:3/3:4 FLIP, NOT A DIFFERENT PAIR BORROWED FROM THE COVER', () => {
  const { IMAGE_SPECS } = require('../src/utils/imageSpecs');
  const landscape = IMAGE_SPECS.article_section_image_landscape;
  const portrait = IMAGE_SPECS.article_section_image_portrait;
  assert.ok(landscape && portrait, 'both new specs must exist');

  assert.equal(landscape.w, 1600);
  assert.equal(landscape.h, 1200);
  assert.ok(Math.abs(landscape.w / landscape.h - 4 / 3) < 0.01);

  assert.equal(portrait.w, 1200);
  assert.equal(portrait.h, 1600);
  assert.ok(Math.abs(portrait.w / portrait.h - 3 / 4) < 0.01);
});

test('THE OLD article_body_image SPEC IS UNTOUCHED — STILL THE ONLY ONE THE "MORE IMAGES" GALLERY USES', () => {
  const { IMAGE_SPECS } = require('../src/utils/imageSpecs');
  assert.equal(IMAGE_SPECS.article_body_image.w, 1600);
  assert.equal(IMAGE_SPECS.article_body_image.h, 1200);
});

test('GET /image-specs EXPOSES BOTH NEW KEYS TO A SIGNED-IN CALLER', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-sectionimgtest';
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1, role: 'member' }; next(); });
  app.use('/image-specs', require('../src/routes/imageSpecs'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(base + '/image-specs');
    const body = await res.json();
    assert.ok(body.specs.article_section_image_landscape);
    assert.ok(body.specs.article_section_image_portrait);
    assert.equal(body.specs.article_section_image_landscape.w, 1600);
    assert.equal(body.specs.article_section_image_portrait.h, 1600);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const [file, sectionHeadPattern] of [
  ['unplug-member-dashboard.html', /<strong>Section \$\{index \+ 1\}<\/strong>/],
  ['unplug-admin-dashboard.html', /<strong>SECTION \$\{index \+ 1\}<\/strong>/],
]) {
  test(`${file}: EACH SECTION RENDERS ITS OWN LANDSCAPE/PORTRAIT TOGGLE, UNIQUELY NAMED SO SECTIONS DON'T FIGHT OVER WHICH IS CHECKED`, () => {
    const src = readSite(file);
    const idx = src.indexOf('function artSectionHtml(index, data)');
    assert.ok(idx > -1, 'artSectionHtml must exist');
    const body = src.slice(idx, src.indexOf('function artRenderSections', idx) > -1
      ? src.indexOf('function artRenderSections', idx)
      : idx + 3000);

    assert.match(body, /name="sectionOrientation-\$\{uid\}" value="landscape" checked/);
    assert.match(body, /name="sectionOrientation-\$\{uid\}" value="portrait"/);
    assert.match(body, /const uid = \+\+_artSectionSeq;/, 'the uid must be independent of the section\'s position, so reordering can\'t rename it');
  });

  test(`${file}: A SECTION'S IMAGE FIELD RESOLVES ITS SPEC THROUGH THE ORIENTATION, NOT A FIXED LITERAL`, () => {
    const src = readSite(file);
    assert.match(src, /function artSectionImageSpecFor\(orientation\) \{\s*\n\s*return imgSpecFull\(orientation === 'portrait' \? 'article_section_image_portrait' : 'article_section_image_landscape'\);/);
    assert.match(src, /UnplugUpload\.fieldHtml\('sectionImage', d\.image_url \|\| '', '', artSectionImageSpecFor\('landscape'\)\)/);
  });

  test(`${file}: SWITCHING ONE SECTION'S TOGGLE RE-RENDERS ONLY THAT SECTION'S IMAGE FIELD, PRESERVING WHAT'S ALREADY UPLOADED`, () => {
    const src = readSite(file);
    const idx = src.indexOf('function artWireSectionOrientation()');
    assert.ok(idx > -1);
    const body = src.slice(idx, idx + 600);
    assert.match(body, /getElementById\('artSections'\)\.addEventListener\('change'/, 'must be ONE delegated listener on the stable container, not per-section wiring');
    assert.match(body, /closest\('input\[name\^="sectionOrientation-"\]'\)/);
    assert.match(body, /UnplugUpload\.valueOf\(imageWrap\)/, 'the current value must be read before re-rendering, not discarded');
    assert.match(body, /artSectionImageSpecFor\(radio\.value\)/);
  });

  test(`${file}: A REAL ALREADY-UPLOADED PORTRAIT IMAGE FLIPS ITS SECTION'S TOGGLE, NOT A BLIND LANDSCAPE DEFAULT`, () => {
    const src = readSite(file);
    const idx = src.indexOf('function artProbeSectionOrientations()');
    assert.ok(idx > -1, 'the probe function must exist for sections whose image already exists (loaded article / restored draft)');
    const body = src.slice(idx, idx + 700);
    assert.match(body, /probe\.naturalHeight > probe\.naturalWidth/, 'a taller-than-wide real image must flip that section to portrait');
    assert.match(body, /section\.querySelector\('input\[value="portrait"\]'\)/);
  });
}

test('unplug-admin-dashboard.html: LOADING AN EXISTING ARTICLE PROBES EVERY SECTION\'S REAL IMAGE, RIGHT AFTER RENDERING THEM', () => {
  const src = readSite('unplug-admin-dashboard.html');
  const idx = src.indexOf('artRenderSections(data.sections || []);');
  assert.ok(idx > -1);
  const after = src.slice(idx, idx + 120);
  assert.match(after, /artProbeSectionOrientations\(\);/);
});

test('unplug-member-dashboard.html: RESTORING A SAVED DRAFT PROBES EVERY REBUILT SECTION\'S REAL IMAGE TOO', () => {
  const src = readSite('unplug-member-dashboard.html');
  const idx = src.indexOf('function restoreDraftForType(type, data)');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('function saveDraftNow', idx));
  assert.match(body, /artProbeSectionOrientations\(\);/);
});

test('THE PER-SECTION SPECS ARE NOT REUSED BY THE UNRELATED "MORE IMAGES" GALLERY FIELD IN EITHER FILE', () => {
  for (const file of ['unplug-member-dashboard.html', 'unplug-admin-dashboard.html']) {
    const src = readSite(file);
    // galleryImage (the "+ Add another image" gallery slots) must still use
    // the plain, single, fixed article_body_image spec — orientation choice
    // is deliberately scoped to the section field only (see the CSS reasons
    // in imageSpecs.js), not extended to the fixed-aspect-ratio gallery grid.
    assert.match(src, /UnplugUpload\.fieldHtml\('galleryImage', value \|\| '', '', imgSpecFull\('article_body_image'\)\)/);
  }
});
