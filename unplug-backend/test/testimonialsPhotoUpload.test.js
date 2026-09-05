// Testimonials — a real image upload for the author's photo, replacing a
// plain "paste a URL" text box. Requested directly: "allow admin to manually
// upload image (same as when publish article)."
//
// testimonials.js already stored/returned author_photo_url as a plain
// string — POST/PATCH never cared how that string was produced — so this is
// a static check on the ADMIN DASHBOARD only: the real UnplugUpload widget
// (person_portrait spec, same one Hall of Fame uses for a headshot) must
// have replaced the free-text input, and the whole panel must have moved to
// the Add-or-Edit-reloads-the-form pattern so a real widget only ever has to
// exist once, not once per table row.
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

test('THE PLAIN PHOTO URL TEXT BOX IS GONE', () => {
  const src = readAdmin();
  assert.ok(!src.includes('id="tstPhotoInput"'), 'the old free-text photo field must be fully replaced, not left dangling');
});

test('A REAL UPLOAD WIDGET EXISTS FOR THE TESTIMONIAL PHOTO, USING THE SAME PORTRAIT SPEC AS HALL OF FAME', () => {
  const src = readAdmin();
  assert.match(src, /<div id="tstPhotoUpload">/);
  const idx = src.indexOf('async function loadTestimonials()');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', src.indexOf('body.appendChild(table);', idx)));
  assert.match(body, /UnplugUpload\.fieldHtml\('tstPhoto', '', '', imgSpecFull\('person_portrait'\)\)/);
});

test('EDITING A TESTIMONIAL RELOADS ITS PHOTO INTO THE SAME WIDGET, NOT A SEPARATE ONE PER ROW', () => {
  const src = readAdmin();
  const idx = src.indexOf("document.getElementById('tstQuoteInput').value = t.quote;");
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('});', idx));
  assert.match(body, /UnplugUpload\.fieldHtml\('tstPhoto', t\.author_photo_url \|\| '', '', imgSpecFull\('person_portrait'\)\)/);
  assert.match(body, /TST_EDITING_ID = t\.id;/);
});

test('SAVING READS THE WIDGET\'S REAL UPLOADED VALUE, NOT A TEXT INPUT', () => {
  const src = readAdmin();
  const idx = src.indexOf("getElementById('createTestimonialBtn').addEventListener('click'");
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n});', idx));
  assert.match(body, /UnplugUpload\.valueOf\(document\.getElementById\('tstPhotoUpload'\)\)/);
});

test('SAVING BRANCHES BETWEEN CREATE AND UPDATE OFF TST_EDITING_ID, SO "SAVE CHANGES" ON AN EDIT DOES NOT CREATE A DUPLICATE ROW', () => {
  const src = readAdmin();
  const idx = src.indexOf("getElementById('createTestimonialBtn').addEventListener('click'");
  const body = src.slice(idx, src.indexOf('\n});', idx));
  assert.match(body, /if \(editingId\)/);
  assert.match(body, /method: 'PATCH'/);
  assert.match(body, /method: 'POST'/);
});
