// Impact Makers, part 2: the admin dashboard UI.
//
// Static-source checks against unplug-admin-dashboard.html — the backend
// (impactMakers.test.js) already covers the real API behaviour; these
// confirm the admin panel actually exposes every spec-required field and
// wires it to the right endpoint/spec key, following the same pattern as
// articleCoverOrientation.test.js and articleSectionImageOrientation.test.js
// from earlier this cycle.
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readAdmin() {
  const file = path.join(__dirname, '..', '..', 'unplug-admin-dashboard.html');
  assert.ok(fs.existsSync(file));
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('THE NAV LINK AND SECTION EXIST AND MATCH ("impactmakers", no separator, like every other single-word section)', () => {
  const src = readAdmin();
  assert.match(src, /<a data-section="impactmakers">Impact Makers<\/a>/);
  assert.match(src, /<div class="admin-section" id="section-impactmakers">/);
  assert.match(src, /section === 'impactmakers'.*loadImpactMakerCategories\(\).*loadImpactMakers\(\)/);
});

test('EVERY SPEC-REQUIRED ADD/EDIT FIELD EXISTS: names, image, category, type, bio, all 7 social/website links, featured, order, status', () => {
  const src = readAdmin();
  for (const id of [
    'imFirstName', 'imSurname', 'imDisplayName', 'imCategory', 'imType', 'imPhotoUpload', 'imBio',
    'imInstagram', 'imFacebook', 'imLinkedin', 'imTiktok', 'imYoutube', 'imX', 'imWebsite',
    'imFeatured', 'imOrder', 'imStatus',
  ]) {
    assert.match(src, new RegExp(`id="${id}"`), `missing form field #${id}`);
  }
});

test('THE 13 TYPE OPTIONS IN THE DROPDOWN MATCH THE BACKEND\'S CHECK CONSTRAINT EXACTLY', () => {
  const migPath = path.join(__dirname, '..', 'db', 'migrations', '175_impact_makers.sql');
  const migration = fs.readFileSync(migPath, 'utf8');
  const constraintMatch = migration.match(/impact_maker_type IN \(([\s\S]*?)\)/);
  assert.ok(constraintMatch);
  const dbTypes = [...constraintMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  const src = readAdmin();
  const selectIdx = src.indexOf('id="imType"');
  const selectHtml = src.slice(selectIdx, src.indexOf('</select>', selectIdx));
  const uiTypes = [...selectHtml.matchAll(/<option value="([a-z_]+)">/g)].map((m) => m[1]);

  assert.deepEqual([...uiTypes].sort(), [...dbTypes].sort(),
    'the dropdown must offer exactly the types the database will actually accept — no more, no less');
});

test('THE PHOTO FIELD USES THE REAL UPLOAD WIDGET AND THE NEW impact_maker_photo SPEC, NOT A BARE URL INPUT', () => {
  const src = readAdmin();
  assert.match(src, /UnplugUpload\.fieldHtml\('impactMakerPhoto', '', '', imgSpecFull\('impact_maker_photo'\)\)/);
  // Confirms the Hall-of-Fame pattern was followed, not Testimonials' bare
  // <input placeholder="https://..."> for author_photo_url.
  const photoFieldIdx = src.indexOf('id="imPhotoUpload"');
  assert.ok(photoFieldIdx > -1);
  const nearby = src.slice(Math.max(0, photoFieldIdx - 200), photoFieldIdx + 50);
  assert.ok(!/placeholder="https:\/\/\.\.\."/.test(nearby), 'must not be a bare URL text input');
});

test('EDITING A ROW LOADS EVERY FIELD BACK INTO THE FORM, INCLUDING THE IMAGE AND ALL 7 SOCIAL LINKS', () => {
  const src = readAdmin();
  const idx = src.indexOf('IM_EDITING_ID = m.id;');
  assert.ok(idx > -1, 'the edit handler must exist and set IM_EDITING_ID');
  const body = src.slice(idx, src.indexOf('actionsTd.appendChild(editBtn)', idx));
  for (const field of ['imFirstName', 'imSurname', 'imDisplayName', 'imCategory', 'imType', 'imStatus',
    'imBio', 'imInstagram', 'imFacebook', 'imLinkedin', 'imTiktok', 'imYoutube', 'imX', 'imWebsite', 'imOrder']) {
    assert.match(body, new RegExp(`getElementById\\('${field}'\\)\\.value`), `edit must restore #${field}`);
  }
  assert.match(body, /getElementById\('imFeatured'\)\.checked/, 'a checkbox is restored via .checked, not .value');
  assert.match(body, /imPhotoUpload'\)\.innerHTML = UnplugUpload\.fieldHtml\('impactMakerPhoto', m\.photo_url/);
});

test('THE MANAGEMENT TABLE HAS EXACTLY THE COLUMNS SPEC §24 ASKS FOR', () => {
  const src = readAdmin();
  const idx = src.indexOf("table.innerHTML = '<tr><th>Name</th><th>Type</th>");
  assert.ok(idx > -1, 'Name | Type | Category | Featured | Status | Order columns, in that order');
  const header = src.slice(idx, src.indexOf(';', idx));
  ['Name', 'Type', 'Category', 'Featured', 'Status', 'Order'].forEach((col) => assert.match(header, new RegExp(`<th>${col}</th>`)));
});

test('EVERY ROW OFFERS EDIT, PREVIEW, ACTIVATE/DEACTIVATE AND DELETE (SPEC §24)', () => {
  const src = readAdmin();
  const idx = src.indexOf('function loadImpactMakers()');
  const body = src.slice(idx, src.indexOf('// ---', idx + 50));
  assert.match(body, /editBtn\.textContent = 'Edit'/);
  assert.match(body, /previewBtn\.textContent = 'Preview'/);
  assert.match(body, /toggleBtn\.textContent = isLive \? 'Deactivate' : 'Activate'/);
  assert.match(body, /delBtn\.textContent = 'Delete'/);
});

test('THE QUICK ACTIVATE/DEACTIVATE TOGGLE FLIPS PUBLISHED<->DRAFT, NOT ANY OTHER STATUS', () => {
  const src = readAdmin();
  assert.match(src, /status: isLive \? 'draft' : 'published'/);
});

test('DELETING A ROW CURRENTLY BEING EDITED RESETS THE FORM RATHER THAN LEAVING IT POINTING AT A GONE ROW', () => {
  const src = readAdmin();
  const idx = src.indexOf("delBtn.addEventListener('click', async () => {\n        if (!confirm(`Delete \"${m.display_name}\"");
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 400);
  assert.match(body, /if \(IM_EDITING_ID === m\.id\) imResetForm\(\);/);
});

test('A NEW ROW IS NEVER CREATED WITH A LIVE STATUS, EVEN IF THE DROPDOWN SHOWS ONE', () => {
  const src = readAdmin();
  const idx = src.indexOf("await api('/impact-makers', { method: 'POST'");
  assert.ok(idx > -1);
  const before = src.slice(Math.max(0, idx - 300), idx);
  assert.match(before, /const \{ status, \.\.\.createPayload \} = payload;/,
    'status must be stripped from the create payload — the server always defaults new rows to draft');
});

test('CATEGORY MANAGEMENT OFFERS ADD, RENAME AND DELETE, EACH CALLING THE REAL ENDPOINT', () => {
  const src = readAdmin();
  assert.match(src, /api\('\/impact-makers\/categories', \{ method: 'POST'/);
  assert.match(src, /api\(`\/impact-makers\/categories\/\$\{c\.id\}`, \{ method: 'PATCH'/);
  assert.match(src, /api\(`\/impact-makers\/categories\/\$\{c\.id\}`, \{ method: 'DELETE'/);
});

test('THE CATEGORY DROPDOWN IS POPULATED FROM THE SAME FETCH THAT BUILDS THE MANAGEMENT TABLE — ONE SOURCE, NOT TWO', () => {
  const src = readAdmin();
  const idx = src.indexOf('async function loadImpactMakerCategories()');
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 500);
  assert.match(body, /IM_CATEGORIES = await api\('\/impact-makers\/categories'\)/);
  assert.match(body, /select\.innerHTML = /, 'the same response must populate the <select>');
});
